# Temporal + ReAct Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ClawHermes-AI-Go 上叠加 Temporal 编排层，实现可 crash-safe 的 ReAct Agent，支持 native function calling，工具来自全部 Skill 类型（LLM/MCP/Code）。

**Architecture:** 四层架构——接入层（agent_handler，零修改）→ 编排层（Temporal ReActWorkflow + ExecuteCapabilityActivity）→ 统一能力门面（capgateway.DefaultCapabilityGateway）→ 适配器（llmgateway 扩展、skillgateway 零修改）。Temporal Worker 随应用 Harness 注册，与 HTTP Server 同进程。

**Tech Stack:** Go 1.24 · Temporal Go SDK `go.temporal.io/sdk` v1.x · Gin v1.9 · Zap · pgxpool · skillgateway（已有）· llmgateway（扩展 tool calling）

---

## 文件映射

| 操作 | 路径 | 职责 |
|------|------|------|
| **修改** | `internal/llmgateway/gateway.go` | 新增 Tool / ToolCall / ToolFunction 类型；CompletionRequest 加 Tools/ToolChoice；CompletionResponse 加 ToolCalls；Message 加 ToolCalls/ToolCallID |
| **修改** | `internal/llmgateway/qwen.go` | Complete() 解析 choices[0].message.tool_calls |
| **修改** | `internal/llmgateway/zhipu.go` | Complete() 解析 choices[0].message.tool_calls |
| **修改** | `internal/llmgateway/gateway_test.go` | 补 tool calling 表驱动测试 |
| **新增** | `internal/capgateway/types.go` | CapabilityRequest/Response/ToolDefinition/ToolCall/LLMMessage/TokenUsage |
| **新增** | `internal/capgateway/gateway.go` | CapabilityGateway 接口 + DefaultCapabilityGateway + ListTools |
| **新增** | `internal/capgateway/llm_adapter.go` | LLM Adapter：capgateway CapLLM → llmgateway.Complete() |
| **新增** | `internal/capgateway/skill_adapter.go` | Skill Adapter：CapSkill → skillgateway.Execute() |
| **新增** | `internal/capgateway/middleware.go` | TenantScope 中间件（注入 tenant_id 到 ctx） |
| **新增** | `internal/capgateway/gateway_test.go` | DefaultCapabilityGateway 单元测试 |
| **新增** | `internal/agent/workflow/types.go` | ReActRequest / ReActResult |
| **新增** | `internal/agent/workflow/react_workflow.go` | ReActWorkflow（Temporal Workflow，确定性循环） |
| **新增** | `internal/agent/workflow/activities.go` | ActivityDeps + ExecuteCapabilityActivity |
| **新增** | `internal/agent/workflow/worker.go` | NewTemporalWorkerComponent（实现 harness.Component） |
| **新增** | `internal/agent/workflow/react_workflow_test.go` | Workflow + Activity 单元测试（testsuite） |
| **修改** | `internal/agent/agent.go` | BaseAgent 加 TemporalClient + CapGateway 字段；ReActAgent 分支改为提交 Temporal Workflow |
| **修改** | `internal/config/config.go` | Config 加 TemporalConfig 字段 |
| **修改** | `cmd/server/main.go` | 初始化 capgateway + Temporal Worker，注册到 Harness |
| **修改** | `docker-compose.yml` | 新增 temporal / temporal-ui 服务 |

---

## Task 1: LLMGateway 扩展——类型定义

**Files:**

- Modify: `internal/llmgateway/gateway.go`

- [ ] **Step 1: 写失败测试**

在 `internal/llmgateway/gateway_test.go` 中新增：

```go
func TestCompletionRequestHasToolsField(t *testing.T) {
    req := CompletionRequest{
        Model:    "qwen-turbo",
        Messages: []Message{{Role: "user", Content: "hi"}},
        Tools: []Tool{{
            Type: "function",
            Function: ToolFunction{
                Name:        "get_weather",
                Description: "Get weather",
                Parameters:  map[string]any{"type": "object"},
            },
        }},
        ToolChoice: "auto",
    }
    b, err := json.Marshal(req)
    require.NoError(t, err)
    require.Contains(t, string(b), `"tools"`)
    require.Contains(t, string(b), `"tool_choice"`)
}

func TestMessageHasToolCallFields(t *testing.T) {
    msg := Message{
        Role: "assistant",
        ToolCalls: []ToolCall{{
            ID:   "call_abc",
            Type: "function",
            Function: struct {
                Name      string `json:"name"`
                Arguments string `json:"arguments"`
            }{Name: "get_weather", Arguments: `{"city":"Beijing"}`},
        }},
    }
    b, err := json.Marshal(msg)
    require.NoError(t, err)
    require.Contains(t, string(b), `"tool_calls"`)
    require.Contains(t, string(b), `"tool_call_id"`) // omitempty — absent when empty is OK
    _ = b
}

func TestCompletionResponseHasToolCallsField(t *testing.T) {
    resp := CompletionResponse{
        ToolCalls: []ToolCall{{ID: "call_1", Type: "function"}},
    }
    b, err := json.Marshal(resp)
    require.NoError(t, err)
    require.Contains(t, string(b), `"tool_calls"`)
}
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go test ./internal/llmgateway/... -run "TestCompletionRequestHasToolsField|TestMessageHasToolCallFields|TestCompletionResponseHasToolCallsField" -v 2>&1 | tail -15
```

期望：`undefined: Tool` 或 `has no field` 编译错误。

- [ ] **Step 3: 在 gateway.go 扩展类型**

在 `internal/llmgateway/gateway.go` 中，替换/扩展现有类型（保留原有字段）：

```go
type Tool struct {
    Type     string       `json:"type"` // "function"
    Function ToolFunction `json:"function"`
}

type ToolFunction struct {
    Name        string         `json:"name"`
    Description string         `json:"description"`
    Parameters  map[string]any `json:"parameters"`
}

type ToolCall struct {
    ID   string `json:"id"`
    Type string `json:"type"` // "function"
    Function struct {
        Name      string `json:"name"`
        Arguments string `json:"arguments"` // JSON string
    } `json:"function"`
}

// Message — 扩展原有结构，新增字段用 omitempty
type Message struct {
    Role       string     `json:"role"`
    Content    string     `json:"content,omitempty"`
    ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
    ToolCallID string     `json:"tool_call_id,omitempty"`
}

// CompletionRequest — 新增 Tools / ToolChoice
type CompletionRequest struct {
    Model       string    `json:"model"`
    Messages    []Message `json:"messages"`
    Temperature float32   `json:"temperature,omitempty"`
    MaxTokens   int       `json:"max_tokens,omitempty"`
    TopP        float32   `json:"top_p,omitempty"`
    Tools       []Tool    `json:"tools,omitempty"`
    ToolChoice  string    `json:"tool_choice,omitempty"`
}

// CompletionResponse — 新增 ToolCalls
type CompletionResponse struct {
    Content   string     `json:"content"`
    Model     string     `json:"model"`
    ToolCalls []ToolCall `json:"tool_calls,omitempty"`
    Usage     struct {
        PromptTokens     int `json:"prompt_tokens"`
        CompletionTokens int `json:"completion_tokens"`
        TotalTokens      int `json:"total_tokens"`
    } `json:"usage"`
}
```

- [ ] **Step 4: 运行确认通过**

```bash
go test ./internal/llmgateway/... -run "TestCompletionRequestHasToolsField|TestMessageHasToolCallFields|TestCompletionResponseHasToolCallsField" -v 2>&1 | tail -10
```

期望：`PASS`

- [ ] **Step 5: 运行全量 llmgateway 测试**

```bash
go test ./internal/llmgateway/... -v 2>&1 | tail -20
```

期望：所有测试通过，无 compile 错误。

- [ ] **Step 6: Commit**

```bash
git add internal/llmgateway/gateway.go internal/llmgateway/gateway_test.go
git commit -m "feat(llmgateway): add Tool/ToolCall/ToolChoice types to CompletionRequest/Response"
```

---

## Task 2: LLMGateway 扩展——Qwen/ZhiPu tool_calls 解析

**Files:**

- Modify: `internal/llmgateway/qwen.go`
- Modify: `internal/llmgateway/zhipu.go`
- Modify: `internal/llmgateway/gateway_test.go`

- [ ] **Step 1: 写失败测试（Qwen）**

在 `internal/llmgateway/gateway_test.go` 中新增（使用 `httptest.NewServer`）：

```go
func TestQwenComplete_ToolCalls(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        fmt.Fprint(w, `{
            "model": "qwen-turbo",
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_001",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": "{\"city\":\"Beijing\"}"}
                    }]
                }
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        }`)
    }))
    defer srv.Close()

    client := NewQwenClientWithBase("test-key", srv.URL, zap.NewNop())
    resp, err := client.Complete(context.Background(), &CompletionRequest{
        Model:    "qwen-turbo",
        Messages: []Message{{Role: "user", Content: "weather?"}},
    })
    require.NoError(t, err)
    require.Len(t, resp.ToolCalls, 1)
    require.Equal(t, "call_001", resp.ToolCalls[0].ID)
    require.Equal(t, "get_weather", resp.ToolCalls[0].Function.Name)
    require.Equal(t, `{"city":"Beijing"}`, resp.ToolCalls[0].Function.Arguments)
    require.Empty(t, resp.Content)
}
```

同样新增 `TestZhipuComplete_ToolCalls`（与上面结构相同，用 `NewZhipuClientWithBase`）。

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/llmgateway/... -run "TestQwenComplete_ToolCalls|TestZhipuComplete_ToolCalls" -v 2>&1 | tail -15
```

期望：`FAIL` — ToolCalls 为空。

- [ ] **Step 3: 修改 qwen.go Complete()**

将 `qwen.go` 中 `Complete()` 的局部解析结构体从：

```go
var out struct {
    Choices []struct {
        Message struct {
            Content string `json:"content"`
        } `json:"message"`
    } `json:"choices"`
    ...
}
```

替换为：

```go
var out struct {
    Choices []struct {
        FinishReason string `json:"finish_reason"`
        Message      struct {
            Content    string     `json:"content"`
            ToolCalls  []ToolCall `json:"tool_calls"`
        } `json:"message"`
    } `json:"choices"`
    Model string `json:"model"`
    Usage struct {
        PromptTokens     int `json:"prompt_tokens"`
        CompletionTokens int `json:"completion_tokens"`
        TotalTokens      int `json:"total_tokens"`
    } `json:"usage"`
}
```

返回处将 ToolCalls 填入 CompletionResponse：

```go
return &CompletionResponse{
    Content:   out.Choices[0].Message.Content,
    Model:     out.Model,
    ToolCalls: out.Choices[0].Message.ToolCalls,
    Usage: struct {
        PromptTokens     int `json:"prompt_tokens"`
        CompletionTokens int `json:"completion_tokens"`
        TotalTokens      int `json:"total_tokens"`
    }{
        PromptTokens:     out.Usage.PromptTokens,
        CompletionTokens: out.Usage.CompletionTokens,
        TotalTokens:      out.Usage.TotalTokens,
    },
}, nil
```

- [ ] **Step 4: 对 zhipu.go 做同样修改**

（与 Step 3 完全对称，仅文件不同）

- [ ] **Step 5: 运行确认通过**

```bash
go test ./internal/llmgateway/... -v -race 2>&1 | tail -20
```

期望：所有测试 `PASS`，无 race。

- [ ] **Step 6: Commit**

```bash
git add internal/llmgateway/qwen.go internal/llmgateway/zhipu.go internal/llmgateway/gateway_test.go
git commit -m "feat(llmgateway): parse tool_calls in qwen/zhipu Complete() responses"
```

---

## Task 3: capgateway——类型定义

**Files:**

- Create: `internal/capgateway/types.go`
- Create: `internal/capgateway/types_test.go`

- [ ] **Step 1: 写失败测试**

新建 `internal/capgateway/types_test.go`：

```go
package capgateway_test

import (
    "encoding/json"
    "testing"
    "time"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/stretchr/testify/require"
)

func TestCapabilityRequestValidate_LLMMissingLLM(t *testing.T) {
    req := capgateway.CapabilityRequest{
        TraceID:  "t1",
        TenantID: "tenant1",
        Type:     capgateway.CapLLM,
        Timeout:  10 * time.Second,
        // LLM: nil  — should fail validation
    }
    err := req.Validate()
    require.Error(t, err)
    require.Contains(t, err.Error(), "LLM")
}

func TestCapabilityRequestValidate_SkillMissingSkill(t *testing.T) {
    req := capgateway.CapabilityRequest{
        TraceID:  "t2",
        TenantID: "tenant1",
        Type:     capgateway.CapSkill,
        Timeout:  10 * time.Second,
    }
    require.Error(t, req.Validate())
}

func TestCapabilityRequestValidate_Valid(t *testing.T) {
    req := capgateway.CapabilityRequest{
        TraceID:  "t3",
        TenantID: "tenant1",
        Type:     capgateway.CapLLM,
        Timeout:  10 * time.Second,
        LLM: &capgateway.LLMCapRequest{
            Model:    "qwen-turbo",
            Messages: []capgateway.LLMMessage{{Role: "user", Content: "hi"}},
        },
    }
    require.NoError(t, req.Validate())
}

func TestToolDefinitionJSONRoundTrip(t *testing.T) {
    td := capgateway.ToolDefinition{
        Name:        "get_weather",
        Description: "Get weather info",
        InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
    }
    b, err := json.Marshal(td)
    require.NoError(t, err)
    var out capgateway.ToolDefinition
    require.NoError(t, json.Unmarshal(b, &out))
    require.Equal(t, td.Name, out.Name)
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/capgateway/... 2>&1 | tail -5
```

期望：`cannot find package` 或 `undefined`。

- [ ] **Step 3: 新建 types.go**

新建 `internal/capgateway/types.go`：

```go
// Package capgateway provides the unified capability routing facade.
package capgateway

import (
    "fmt"
    "time"
)

type CapabilityType string

const (
    CapLLM   CapabilityType = "llm"
    CapSkill CapabilityType = "skill"
)

type CapabilityRequest struct {
    TraceID  string
    TenantID string
    Type     CapabilityType
    LLM      *LLMCapRequest
    Skill    *SkillCapRequest
    Timeout  time.Duration
}

func (r CapabilityRequest) Validate() error {
    switch r.Type {
    case CapLLM:
        if r.LLM == nil {
            return fmt.Errorf("capgateway: LLM request required for type %q", CapLLM)
        }
    case CapSkill:
        if r.Skill == nil {
            return fmt.Errorf("capgateway: Skill request required for type %q", CapSkill)
        }
    default:
        return fmt.Errorf("capgateway: unknown capability type %q", r.Type)
    }
    return nil
}

type LLMCapRequest struct {
    Model       string
    Messages    []LLMMessage
    Tools       []ToolDefinition
    Temperature float32
    MaxTokens   int
}

type SkillCapRequest struct {
    SkillID string
    Input   any
}

type CapabilityResponse struct {
    TraceID   string
    Type      CapabilityType
    Duration  time.Duration
    Content   string
    ToolCalls []ToolCall
    Usage     TokenUsage
    Output    any
}

type ToolDefinition struct {
    Name        string         `json:"name"`
    Description string         `json:"description"`
    InputSchema map[string]any `json:"input_schema"`
}

type ToolCall struct {
    ID        string         `json:"id"`
    Name      string         `json:"name"`
    Arguments map[string]any `json:"arguments"`
}

type LLMMessage struct {
    Role       string
    Content    string
    ToolCallID string
    ToolCalls  []ToolCall
}

type TokenUsage struct {
    Prompt     int
    Completion int
    Total      int
}
```

- [ ] **Step 4: 运行确认通过**

```bash
go test ./internal/capgateway/... -v 2>&1 | tail -15
```

期望：4 个测试 `PASS`。

- [ ] **Step 5: Commit**

```bash
git add internal/capgateway/
git commit -m "feat(capgateway): add CapabilityRequest/Response types with validation"
```

---

## Task 4: capgateway——LLM Adapter

**Files:**

- Create: `internal/capgateway/llm_adapter.go`
- Create: `internal/capgateway/llm_adapter_test.go`

- [ ] **Step 1: 写失败测试**

新建 `internal/capgateway/llm_adapter_test.go`：

```go
package capgateway_test

import (
    "context"
    "errors"
    "testing"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
    "github.com/stretchr/testify/require"
    "go.uber.org/zap"
)

type mockLLMGateway struct {
    resp *llmgateway.CompletionResponse
    err  error
}

func (m *mockLLMGateway) Complete(_ context.Context, _ *llmgateway.CompletionRequest) (*llmgateway.CompletionResponse, error) {
    return m.resp, m.err
}

func TestLLMAdapter_RouteTextContent(t *testing.T) {
    mock := &mockLLMGateway{
        resp: &llmgateway.CompletionResponse{
            Content: "hello world",
            Model:   "qwen-turbo",
        },
    }
    adapter := capgateway.NewLLMAdapter(mock, zap.NewNop())

    req := capgateway.CapabilityRequest{
        TraceID:  "trace-1",
        TenantID: "t1",
        Type:     capgateway.CapLLM,
        LLM: &capgateway.LLMCapRequest{
            Model:    "qwen-turbo",
            Messages: []capgateway.LLMMessage{{Role: "user", Content: "hi"}},
        },
    }
    resp, err := adapter.Route(context.Background(), req)
    require.NoError(t, err)
    require.Equal(t, "hello world", resp.Content)
    require.Empty(t, resp.ToolCalls)
}

func TestLLMAdapter_RouteToolCalls(t *testing.T) {
    mock := &mockLLMGateway{
        resp: &llmgateway.CompletionResponse{
            ToolCalls: []llmgateway.ToolCall{{
                ID:   "call_1",
                Type: "function",
                Function: struct {
                    Name      string `json:"name"`
                    Arguments string `json:"arguments"`
                }{Name: "get_weather", Arguments: `{"city":"Beijing"}`},
            }},
        },
    }
    adapter := capgateway.NewLLMAdapter(mock, zap.NewNop())

    req := capgateway.CapabilityRequest{
        Type: capgateway.CapLLM,
        LLM:  &capgateway.LLMCapRequest{Model: "qwen-turbo", Messages: []capgateway.LLMMessage{{Role: "user", Content: "weather?"}}},
    }
    resp, err := adapter.Route(context.Background(), req)
    require.NoError(t, err)
    require.Len(t, resp.ToolCalls, 1)
    require.Equal(t, "get_weather", resp.ToolCalls[0].Name)
    require.Equal(t, "Beijing", resp.ToolCalls[0].Arguments["city"])
}

func TestLLMAdapter_RouteError(t *testing.T) {
    mock := &mockLLMGateway{err: errors.New("upstream down")}
    adapter := capgateway.NewLLMAdapter(mock, zap.NewNop())

    req := capgateway.CapabilityRequest{
        Type: capgateway.CapLLM,
        LLM:  &capgateway.LLMCapRequest{Model: "qwen-turbo", Messages: []capgateway.LLMMessage{{Role: "user", Content: "hi"}}},
    }
    _, err := adapter.Route(context.Background(), req)
    require.Error(t, err)
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/capgateway/... -run "TestLLMAdapter" -v 2>&1 | tail -10
```

期望：`undefined: capgateway.NewLLMAdapter`。

- [ ] **Step 3: 实现 llm_adapter.go**

新建 `internal/capgateway/llm_adapter.go`：

```go
package capgateway

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
    "go.uber.org/zap"
)

// LLMCompleter is the minimal interface LLMAdapter needs from llmgateway.Gateway.
type LLMCompleter interface {
    Complete(ctx context.Context, req *llmgateway.CompletionRequest) (*llmgateway.CompletionResponse, error)
}

type LLMAdapter struct {
    gw     LLMCompleter
    logger *zap.Logger
}

func NewLLMAdapter(gw LLMCompleter, logger *zap.Logger) *LLMAdapter {
    return &LLMAdapter{gw: gw, logger: logger}
}

func (a *LLMAdapter) Route(ctx context.Context, req CapabilityRequest) (CapabilityResponse, error) {
    start := time.Now()
    llmReq := buildLLMRequest(req.LLM)
    raw, err := a.gw.Complete(ctx, llmReq)
    if err != nil {
        return CapabilityResponse{}, fmt.Errorf("llm_adapter: %w", err)
    }
    return buildCapabilityResponse(req.TraceID, raw, time.Since(start)), nil
}

func buildLLMRequest(r *LLMCapRequest) *llmgateway.CompletionRequest {
    msgs := make([]llmgateway.Message, len(r.Messages))
    for i, m := range r.Messages {
        msgs[i] = llmgateway.Message{
            Role:       m.Role,
            Content:    m.Content,
            ToolCallID: m.ToolCallID,
            ToolCalls:  convertToolCallsToGW(m.ToolCalls),
        }
    }
    tools := make([]llmgateway.Tool, len(r.Tools))
    for i, td := range r.Tools {
        tools[i] = llmgateway.Tool{
            Type: "function",
            Function: llmgateway.ToolFunction{
                Name:        td.Name,
                Description: td.Description,
                Parameters:  td.InputSchema,
            },
        }
    }
    return &llmgateway.CompletionRequest{
        Model:       r.Model,
        Messages:    msgs,
        Temperature: r.Temperature,
        MaxTokens:   r.MaxTokens,
        Tools:       tools,
        ToolChoice:  choiceFromTools(tools),
    }
}

func choiceFromTools(tools []llmgateway.Tool) string {
    if len(tools) == 0 {
        return ""
    }
    return "auto"
}

func buildCapabilityResponse(traceID string, raw *llmgateway.CompletionResponse, dur time.Duration) CapabilityResponse {
    tcs := make([]ToolCall, len(raw.ToolCalls))
    for i, tc := range raw.ToolCalls {
        args := map[string]any{}
        _ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
        tcs[i] = ToolCall{ID: tc.ID, Name: tc.Function.Name, Arguments: args}
    }
    return CapabilityResponse{
        TraceID:   traceID,
        Type:      CapLLM,
        Duration:  dur,
        Content:   raw.Content,
        ToolCalls: tcs,
        Usage: TokenUsage{
            Prompt:     raw.Usage.PromptTokens,
            Completion: raw.Usage.CompletionTokens,
            Total:      raw.Usage.TotalTokens,
        },
    }
}

func convertToolCallsToGW(tcs []ToolCall) []llmgateway.ToolCall {
    if len(tcs) == 0 {
        return nil
    }
    out := make([]llmgateway.ToolCall, len(tcs))
    for i, tc := range tcs {
        b, _ := json.Marshal(tc.Arguments)
        out[i] = llmgateway.ToolCall{
            ID:   tc.ID,
            Type: "function",
            Function: struct {
                Name      string `json:"name"`
                Arguments string `json:"arguments"`
            }{Name: tc.Name, Arguments: string(b)},
        }
    }
    return out
}
```

- [ ] **Step 4: 运行确认通过**

```bash
go test ./internal/capgateway/... -v -race 2>&1 | tail -20
```

期望：所有测试 `PASS`。

- [ ] **Step 5: Commit**

```bash
git add internal/capgateway/llm_adapter.go internal/capgateway/llm_adapter_test.go
git commit -m "feat(capgateway): add LLMAdapter bridging capgateway → llmgateway"
```

---

## Task 5: capgateway——Skill Adapter

**Files:**

- Create: `internal/capgateway/skill_adapter.go`
- Create: `internal/capgateway/skill_adapter_test.go`

- [ ] **Step 1: 写失败测试**

新建 `internal/capgateway/skill_adapter_test.go`：

```go
package capgateway_test

import (
    "context"
    "errors"
    "testing"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/skillgateway"
    "github.com/stretchr/testify/require"
    "go.uber.org/zap"
)

type mockSkillGateway struct {
    resp skillgateway.SkillResponse
    err  error
}

func (m *mockSkillGateway) Execute(_ context.Context, req skillgateway.SkillRequest) (skillgateway.SkillResponse, error) {
    return m.resp, m.err
}

func TestSkillAdapter_RouteSuccess(t *testing.T) {
    mock := &mockSkillGateway{
        resp: skillgateway.SkillResponse{SkillID: "skill_a", Output: "42"},
    }
    adapter := capgateway.NewSkillAdapter(mock, zap.NewNop())

    req := capgateway.CapabilityRequest{
        TraceID:  "tr1",
        TenantID: "t1",
        Type:     capgateway.CapSkill,
        Skill:    &capgateway.SkillCapRequest{SkillID: "skill_a", Input: map[string]any{"x": 1}},
    }
    resp, err := adapter.Route(context.Background(), req)
    require.NoError(t, err)
    require.Equal(t, capgateway.CapSkill, resp.Type)
    require.Equal(t, "42", resp.Output)
}

func TestSkillAdapter_RouteError(t *testing.T) {
    mock := &mockSkillGateway{err: errors.New("skill failed")}
    adapter := capgateway.NewSkillAdapter(mock, zap.NewNop())

    req := capgateway.CapabilityRequest{
        Type:  capgateway.CapSkill,
        Skill: &capgateway.SkillCapRequest{SkillID: "skill_b"},
    }
    _, err := adapter.Route(context.Background(), req)
    require.Error(t, err)
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/capgateway/... -run "TestSkillAdapter" -v 2>&1 | tail -10
```

- [ ] **Step 3: 实现 skill_adapter.go**

新建 `internal/capgateway/skill_adapter.go`：

```go
package capgateway

import (
    "context"
    "fmt"
    "time"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/skillgateway"
    "go.uber.org/zap"
)

// SkillExecutor is the minimal interface SkillAdapter needs from skillgateway.
type SkillExecutor interface {
    Execute(ctx context.Context, req skillgateway.SkillRequest) (skillgateway.SkillResponse, error)
}

type SkillAdapter struct {
    gw     SkillExecutor
    logger *zap.Logger
}

func NewSkillAdapter(gw SkillExecutor, logger *zap.Logger) *SkillAdapter {
    return &SkillAdapter{gw: gw, logger: logger}
}

func (a *SkillAdapter) Route(ctx context.Context, req CapabilityRequest) (CapabilityResponse, error) {
    start := time.Now()
    skillReq := skillgateway.SkillRequest{
        TraceID: req.TraceID,
        SkillID: req.Skill.SkillID,
        Input:   req.Skill.Input,
    }
    skillResp, err := a.gw.Execute(ctx, skillReq)
    if err != nil {
        return CapabilityResponse{}, fmt.Errorf("skill_adapter: %w", err)
    }
    return CapabilityResponse{
        TraceID:  req.TraceID,
        Type:     CapSkill,
        Duration: time.Since(start),
        Output:   skillResp.Output,
    }, nil
}
```

- [ ] **Step 4: 运行确认通过**

```bash
go test ./internal/capgateway/... -v -race 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add internal/capgateway/skill_adapter.go internal/capgateway/skill_adapter_test.go
git commit -m "feat(capgateway): add SkillAdapter bridging capgateway → skillgateway"
```

---

## Task 6: capgateway——Gateway 接口 + DefaultCapabilityGateway

**Files:**

- Create: `internal/capgateway/gateway.go`
- Create: `internal/capgateway/gateway_test.go`

- [ ] **Step 1: 写失败测试**

新建 `internal/capgateway/gateway_test.go`：

```go
package capgateway_test

import (
    "context"
    "testing"
    "time"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/llmgateway"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/skillgateway"
    "github.com/stretchr/testify/require"
    "go.uber.org/zap"
)

func TestDefaultCapabilityGateway_RouteLLM(t *testing.T) {
    llmMock := &mockLLMGateway{resp: &llmgateway.CompletionResponse{Content: "ok"}}
    skillMock := &mockSkillGateway{}
    gw := capgateway.NewDefaultCapabilityGateway(
        capgateway.NewLLMAdapter(llmMock, zap.NewNop()),
        capgateway.NewSkillAdapter(skillMock, zap.NewNop()),
        zap.NewNop(),
    )

    req := capgateway.CapabilityRequest{
        TraceID:  "t1",
        TenantID: "tenant1",
        Type:     capgateway.CapLLM,
        Timeout:  5 * time.Second,
        LLM:      &capgateway.LLMCapRequest{Model: "qwen-turbo", Messages: []capgateway.LLMMessage{{Role: "user", Content: "hi"}}},
    }
    resp, err := gw.Route(context.Background(), req)
    require.NoError(t, err)
    require.Equal(t, "ok", resp.Content)
}

func TestDefaultCapabilityGateway_RouteSkill(t *testing.T) {
    llmMock := &mockLLMGateway{}
    skillMock := &mockSkillGateway{resp: skillgateway.SkillResponse{Output: "result"}}
    gw := capgateway.NewDefaultCapabilityGateway(
        capgateway.NewLLMAdapter(llmMock, zap.NewNop()),
        capgateway.NewSkillAdapter(skillMock, zap.NewNop()),
        zap.NewNop(),
    )

    req := capgateway.CapabilityRequest{
        Type:  capgateway.CapSkill,
        Skill: &capgateway.SkillCapRequest{SkillID: "s1", Input: "data"},
    }
    resp, err := gw.Route(context.Background(), req)
    require.NoError(t, err)
    require.Equal(t, "result", resp.Output)
}

func TestDefaultCapabilityGateway_RouteValidationError(t *testing.T) {
    gw := capgateway.NewDefaultCapabilityGateway(
        capgateway.NewLLMAdapter(&mockLLMGateway{}, zap.NewNop()),
        capgateway.NewSkillAdapter(&mockSkillGateway{}, zap.NewNop()),
        zap.NewNop(),
    )
    req := capgateway.CapabilityRequest{Type: capgateway.CapLLM} // LLM == nil
    _, err := gw.Route(context.Background(), req)
    require.Error(t, err)
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/capgateway/... -run "TestDefaultCapabilityGateway" -v 2>&1 | tail -10
```

- [ ] **Step 3: 实现 gateway.go**

新建 `internal/capgateway/gateway.go`：

```go
package capgateway

import (
    "context"
    "fmt"

    "go.uber.org/zap"
)

// CapabilityGateway is the unified capability routing facade.
type CapabilityGateway interface {
    Route(ctx context.Context, req CapabilityRequest) (CapabilityResponse, error)
}

// Adapter is the common interface for LLM and Skill adapters.
type Adapter interface {
    Route(ctx context.Context, req CapabilityRequest) (CapabilityResponse, error)
}

type DefaultCapabilityGateway struct {
    llm    Adapter
    skill  Adapter
    logger *zap.Logger
}

func NewDefaultCapabilityGateway(llm Adapter, skill Adapter, logger *zap.Logger) *DefaultCapabilityGateway {
    return &DefaultCapabilityGateway{llm: llm, skill: skill, logger: logger}
}

func (g *DefaultCapabilityGateway) Route(ctx context.Context, req CapabilityRequest) (CapabilityResponse, error) {
    if err := req.Validate(); err != nil {
        return CapabilityResponse{}, err
    }
    switch req.Type {
    case CapLLM:
        return g.llm.Route(ctx, req)
    case CapSkill:
        return g.skill.Route(ctx, req)
    default:
        return CapabilityResponse{}, fmt.Errorf("capgateway: unknown type %q", req.Type)
    }
}
```

- [ ] **Step 4: 运行确认通过**

```bash
go test ./internal/capgateway/... -v -race 2>&1 | tail -20
```

期望：全部 `PASS`，覆盖率应 ≥80%。验证：

```bash
go test ./internal/capgateway/... -cover 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add internal/capgateway/gateway.go internal/capgateway/gateway_test.go
git commit -m "feat(capgateway): add CapabilityGateway interface and DefaultCapabilityGateway"
```

---

## Task 7: 安装 Temporal Go SDK + Config 扩展

**Files:**

- Modify: `go.mod` / `go.sum`（由 `go get` 自动更新）
- Modify: `internal/config/config.go`

- [ ] **Step 1: 安装 Temporal Go SDK**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go get go.temporal.io/sdk@latest
go mod tidy
```

确认版本：

```bash
grep "go.temporal.io/sdk" go.mod
```

期望：输出类似 `go.temporal.io/sdk v1.29.x`。

- [ ] **Step 2: 写 Config 测试**

在 `internal/config/config.go` 同目录新增 `temporal_config_test.go`（或追加到现有测试文件）：

```go
func TestTemporalConfigDefaults(t *testing.T) {
    // TemporalConfig zero value must have safe defaults
    var cfg config.TemporalConfig
    require.Equal(t, "", cfg.HostPort) // empty means not configured
}
```

- [ ] **Step 3: 扩展 Config**

在 `internal/config/config.go` 中：

1. 新增 `TemporalConfig` 结构体：

```go
type TemporalConfig struct {
    HostPort                    string
    Namespace                   string
    TaskQueue                   string
    WorkerMaxConcurrentActivities int
    WorkerMaxConcurrentWorkflows  int
}
```

1. 在 `Config` struct 中新增字段：

```go
Temporal TemporalConfig
```

1. 在 `Load()` 函数中填充（在返回前）：

```go
Temporal: TemporalConfig{
    HostPort:                    getEnv("TEMPORAL_HOST_PORT", "localhost:7233"),
    Namespace:                   getEnv("TEMPORAL_NAMESPACE", "clawhermes"),
    TaskQueue:                   getEnv("TEMPORAL_TASK_QUEUE", "agent-react"),
    WorkerMaxConcurrentActivities: 20,
    WorkerMaxConcurrentWorkflows:  100,
},
```

- [ ] **Step 4: 运行 go vet**

```bash
go vet ./internal/config/... 2>&1
```

期望：无错误。

- [ ] **Step 5: Commit**

```bash
git add go.mod go.sum internal/config/config.go
git commit -m "feat(config): add TemporalConfig; install temporal go sdk"
```

---

## Task 8: Temporal Worker——workflow types + worker component

**Files:**

- Create: `internal/agent/workflow/types.go`
- Create: `internal/agent/workflow/worker.go`
- Create: `internal/agent/workflow/worker_test.go`

- [ ] **Step 1: 写 worker 测试**

新建 `internal/agent/workflow/worker_test.go`：

```go
package workflow_test

import (
    "context"
    "testing"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/workflow"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/config"
    "github.com/stretchr/testify/require"
    "go.uber.org/zap"
)

func TestNewTemporalWorkerComponent_Name(t *testing.T) {
    cfg := &config.TemporalConfig{
        HostPort:  "localhost:7233",
        Namespace: "default",
        TaskQueue: "test",
    }
    comp := workflow.NewTemporalWorkerComponent(cfg, nil, zap.NewNop())
    require.Equal(t, "temporal-worker", comp.Name())
}

func TestTemporalWorkerComponent_StopWithoutStart(t *testing.T) {
    cfg := &config.TemporalConfig{HostPort: "localhost:7233", Namespace: "default", TaskQueue: "test"}
    comp := workflow.NewTemporalWorkerComponent(cfg, nil, zap.NewNop())
    // Stop before Start must not panic
    require.NoError(t, comp.Stop(context.Background()))
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/agent/workflow/... 2>&1 | tail -5
```

- [ ] **Step 3: 新建 types.go**

新建 `internal/agent/workflow/types.go`：

```go
package workflow

import "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"

// ReActRequest is the workflow input.
type ReActRequest struct {
    TraceID        string
    TenantID       string
    AgentID        string
    Input          string
    AgentCfg       AgentWorkflowConfig
    AvailableTools []capgateway.ToolDefinition
}

// AgentWorkflowConfig holds the fields from AgentConfig that the workflow needs.
type AgentWorkflowConfig struct {
    ID            string
    Name          string
    LLMModel      string
    SystemPrompt  string
    MaxIterations int
}

// ReActResult is the workflow output.
type ReActResult struct {
    Output    string
    ToolCalls []capgateway.ToolCall
    Steps     int
}
```

- [ ] **Step 4: 新建 worker.go**

新建 `internal/agent/workflow/worker.go`：

```go
package workflow

import (
    "context"
    "fmt"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/config"
    "go.temporal.io/sdk/client"
    "go.temporal.io/sdk/worker"
    "go.uber.org/zap"
)

const TaskQueue = "agent-react"

// TemporalWorkerComponent implements harness.Component.
type TemporalWorkerComponent struct {
    cfg     *config.TemporalConfig
    capGW   capgateway.CapabilityGateway
    logger  *zap.Logger
    client  client.Client
    worker  worker.Worker
}

func NewTemporalWorkerComponent(
    cfg *config.TemporalConfig,
    capGW capgateway.CapabilityGateway,
    logger *zap.Logger,
) *TemporalWorkerComponent {
    return &TemporalWorkerComponent{cfg: cfg, capGW: capGW, logger: logger}
}

func (c *TemporalWorkerComponent) Name() string { return "temporal-worker" }

func (c *TemporalWorkerComponent) Start(ctx context.Context) error {
    cl, err := client.Dial(client.Options{
        HostPort:  c.cfg.HostPort,
        Namespace: c.cfg.Namespace,
        Logger:    newZapTemporalLogger(c.logger),
    })
    if err != nil {
        return fmt.Errorf("temporal-worker: dial: %w", err)
    }
    c.client = cl

    taskQueue := c.cfg.TaskQueue
    if taskQueue == "" {
        taskQueue = TaskQueue
    }
    w := worker.New(cl, taskQueue, worker.Options{
        MaxConcurrentActivityExecutionSize: c.cfg.WorkerMaxConcurrentActivities,
        MaxConcurrentWorkflowTaskExecutionSize: c.cfg.WorkerMaxConcurrentWorkflows,
    })

    deps := &ActivityDeps{CapGateway: c.capGW}
    w.RegisterWorkflow(ReActWorkflow)
    w.RegisterActivity(deps.ExecuteCapabilityActivity)

    if err := w.Start(); err != nil {
        return fmt.Errorf("temporal-worker: start: %w", err)
    }
    c.worker = w
    c.logger.Info("temporal worker started", zap.String("task_queue", taskQueue))
    return nil
}

func (c *TemporalWorkerComponent) Stop(_ context.Context) error {
    if c.worker != nil {
        c.worker.Stop()
    }
    if c.client != nil {
        c.client.Close()
    }
    return nil
}

func (c *TemporalWorkerComponent) HealthCheck(_ context.Context) error {
    if c.client == nil {
        return fmt.Errorf("temporal client not initialized")
    }
    return nil
}

// Client returns the Temporal client for workflow submission (used by BaseAgent).
func (c *TemporalWorkerComponent) Client() client.Client { return c.client }
```

- [ ] **Step 5: 新建 temporal_logger.go**（Temporal 需要一个 log.Logger 接口适配器）

新建 `internal/agent/workflow/temporal_logger.go`：

```go
package workflow

import (
    "go.temporal.io/sdk/log"
    "go.uber.org/zap"
)

type zapTemporalLogger struct{ l *zap.Logger }

func newZapTemporalLogger(l *zap.Logger) log.Logger { return &zapTemporalLogger{l: l} }

func (z *zapTemporalLogger) Debug(msg string, kvs ...interface{}) {
    z.l.Sugar().Debugw(msg, kvs...)
}
func (z *zapTemporalLogger) Info(msg string, kvs ...interface{}) {
    z.l.Sugar().Infow(msg, kvs...)
}
func (z *zapTemporalLogger) Warn(msg string, kvs ...interface{}) {
    z.l.Sugar().Warnw(msg, kvs...)
}
func (z *zapTemporalLogger) Error(msg string, kvs ...interface{}) {
    z.l.Sugar().Errorw(msg, kvs...)
}
```

- [ ] **Step 6: 运行确认通过**

```bash
go test ./internal/agent/workflow/... -v 2>&1 | tail -15
```

期望：`TestNewTemporalWorkerComponent_Name` 和 `TestTemporalWorkerComponent_StopWithoutStart` 均 `PASS`。

- [ ] **Step 7: go vet**

```bash
go vet ./internal/agent/workflow/... 2>&1
```

- [ ] **Step 8: Commit**

```bash
git add internal/agent/workflow/
git commit -m "feat(workflow): add TemporalWorkerComponent and workflow types"
```

---

## Task 9: ReAct Workflow + Activity

**Files:**

- Create: `internal/agent/workflow/react_workflow.go`
- Create: `internal/agent/workflow/activities.go`
- Create: `internal/agent/workflow/react_workflow_test.go`

- [ ] **Step 1: 写 workflow 单元测试（使用 Temporal testsuite）**

新建 `internal/agent/workflow/react_workflow_test.go`：

```go
package workflow_test

import (
    "context"
    "encoding/json"
    "testing"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/workflow"
    "github.com/stretchr/testify/mock"
    "github.com/stretchr/testify/require"
    "github.com/stretchr/testify/suite"
    "go.temporal.io/sdk/testsuite"
)

type WorkflowTestSuite struct {
    suite.Suite
    testsuite.WorkflowTestSuite
    env *testsuite.TestWorkflowEnvironment
}

func (s *WorkflowTestSuite) SetupTest() {
    s.env = s.NewTestWorkflowEnvironment()
}

func (s *WorkflowTestSuite) TearDownTest() {
    s.env.AssertExpectations(s.T())
}

// TestReActWorkflow_DirectAnswer — LLM returns text, no tool calls
func (s *WorkflowTestSuite) TestReActWorkflow_DirectAnswer() {
    req := workflow.ReActRequest{
        TraceID:  "tr1",
        TenantID: "t1",
        Input:    "What is 2+2?",
        AgentCfg: workflow.AgentWorkflowConfig{
            ID: "agent1", LLMModel: "qwen-turbo", MaxIterations: 5,
        },
    }

    // Mock the activity: LLM returns direct answer
    s.env.OnActivity(workflow.ExecuteCapabilityActivityName, mock.Anything, mock.MatchedBy(func(r capgateway.CapabilityRequest) bool {
        return r.Type == capgateway.CapLLM
    })).Return(capgateway.CapabilityResponse{Content: "4", Type: capgateway.CapLLM}, nil).Once()

    s.env.ExecuteWorkflow(workflow.ReActWorkflow, req)

    require.True(s.T(), s.env.IsWorkflowCompleted())
    require.NoError(s.T(), s.env.GetWorkflowError())

    var result workflow.ReActResult
    require.NoError(s.T(), s.env.GetWorkflowResult(&result))
    require.Equal(s.T(), "4", result.Output)
    require.Equal(s.T(), 1, result.Steps)
}

// TestReActWorkflow_OneToolCall — LLM returns tool call, then final answer
func (s *WorkflowTestSuite) TestReActWorkflow_OneToolCall() {
    req := workflow.ReActRequest{
        TraceID:  "tr2",
        TenantID: "t1",
        Input:    "Weather in Beijing?",
        AgentCfg: workflow.AgentWorkflowConfig{
            ID: "agent1", LLMModel: "qwen-turbo", MaxIterations: 5,
        },
        AvailableTools: []capgateway.ToolDefinition{{Name: "get_weather", Description: "weather"}},
    }

    callArgs, _ := json.Marshal(map[string]any{"city": "Beijing"})
    _ = callArgs

    // First LLM call: returns tool_call
    s.env.OnActivity(workflow.ExecuteCapabilityActivityName, mock.Anything, mock.MatchedBy(func(r capgateway.CapabilityRequest) bool {
        return r.Type == capgateway.CapLLM && len(r.LLM.Messages) == 1
    })).Return(capgateway.CapabilityResponse{
        Type: capgateway.CapLLM,
        ToolCalls: []capgateway.ToolCall{{ID: "c1", Name: "get_weather", Arguments: map[string]any{"city": "Beijing"}}},
    }, nil).Once()

    // Skill call: execute get_weather
    s.env.OnActivity(workflow.ExecuteCapabilityActivityName, mock.Anything, mock.MatchedBy(func(r capgateway.CapabilityRequest) bool {
        return r.Type == capgateway.CapSkill && r.Skill.SkillID == "get_weather"
    })).Return(capgateway.CapabilityResponse{Type: capgateway.CapSkill, Output: "sunny, 25°C"}, nil).Once()

    // Second LLM call: returns final answer
    s.env.OnActivity(workflow.ExecuteCapabilityActivityName, mock.Anything, mock.MatchedBy(func(r capgateway.CapabilityRequest) bool {
        return r.Type == capgateway.CapLLM && len(r.LLM.Messages) > 1
    })).Return(capgateway.CapabilityResponse{Content: "Beijing is sunny, 25°C", Type: capgateway.CapLLM}, nil).Once()

    s.env.ExecuteWorkflow(workflow.ReActWorkflow, req)

    require.True(s.T(), s.env.IsWorkflowCompleted())
    require.NoError(s.T(), s.env.GetWorkflowError())

    var result workflow.ReActResult
    require.NoError(s.T(), s.env.GetWorkflowResult(&result))
    require.Equal(s.T(), "Beijing is sunny, 25°C", result.Output)
    require.Len(s.T(), result.ToolCalls, 1)
}

// TestReActWorkflow_MaxIterationsReached
func (s *WorkflowTestSuite) TestReActWorkflow_MaxIterationsReached() {
    req := workflow.ReActRequest{
        Input:    "loop forever",
        AgentCfg: workflow.AgentWorkflowConfig{MaxIterations: 2},
    }
    // Both LLM calls return tool_calls with no terminal answer
    s.env.OnActivity(workflow.ExecuteCapabilityActivityName, mock.Anything, mock.Anything).
        Return(capgateway.CapabilityResponse{
            Type:      capgateway.CapLLM,
            ToolCalls: []capgateway.ToolCall{{ID: "c1", Name: "tool_a"}},
        }, nil).Times(2)
    s.env.OnActivity(workflow.ExecuteCapabilityActivityName, mock.Anything, mock.MatchedBy(func(r capgateway.CapabilityRequest) bool {
        return r.Type == capgateway.CapSkill
    })).Return(capgateway.CapabilityResponse{Type: capgateway.CapSkill, Output: "ok"}, nil).Times(2)

    s.env.ExecuteWorkflow(workflow.ReActWorkflow, req)
    require.True(s.T(), s.env.IsWorkflowCompleted())
    require.Error(s.T(), s.env.GetWorkflowError())
}

func TestWorkflowSuite(t *testing.T) {
    suite.Run(t, new(WorkflowTestSuite))
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/agent/workflow/... -run "TestWorkflowSuite" -v 2>&1 | tail -10
```

- [ ] **Step 3: 实现 activities.go**

新建 `internal/agent/workflow/activities.go`：

```go
package workflow

import (
    "context"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
)

// ExecuteCapabilityActivityName is used for activity mocking in tests.
const ExecuteCapabilityActivityName = "ExecuteCapabilityActivity"

// ActivityDeps holds dependencies injected via closure capture (Temporal Go SDK pattern).
type ActivityDeps struct {
    CapGateway capgateway.CapabilityGateway
}

func (d *ActivityDeps) ExecuteCapabilityActivity(ctx context.Context, req capgateway.CapabilityRequest) (capgateway.CapabilityResponse, error) {
    return d.CapGateway.Route(ctx, req)
}
```

- [ ] **Step 4: 实现 react_workflow.go**

新建 `internal/agent/workflow/react_workflow.go`：

```go
package workflow

import (
    "fmt"
    "time"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "go.temporal.io/sdk/activity"
    "go.temporal.io/sdk/temporal"
    "go.temporal.io/sdk/workflow"
)

func ReActWorkflow(ctx workflow.Context, req ReActRequest) (*ReActResult, error) {
    messages := buildInitialMessages(req.AgentCfg, req.Input)
    var allToolCalls []capgateway.ToolCall
    steps := 0

    for i := 0; i < maxIterations(req.AgentCfg.MaxIterations); i++ {
        llmResp, err := callCapabilityActivity(ctx, capgateway.CapabilityRequest{
            TraceID:  req.TraceID,
            TenantID: req.TenantID,
            Type:     capgateway.CapLLM,
            Timeout:  60 * time.Second,
            LLM: &capgateway.LLMCapRequest{
                Model:    req.AgentCfg.LLMModel,
                Messages: messages,
                Tools:    req.AvailableTools,
            },
        })
        if err != nil {
            return nil, fmt.Errorf("react: llm step %d: %w", i, err)
        }
        steps++

        if len(llmResp.ToolCalls) == 0 {
            return &ReActResult{Output: llmResp.Content, ToolCalls: allToolCalls, Steps: steps}, nil
        }

        messages = append(messages, capgateway.LLMMessage{
            Role:      "assistant",
            ToolCalls: llmResp.ToolCalls,
        })

        for _, tc := range llmResp.ToolCalls {
            toolResp, err := callCapabilityActivity(ctx, capgateway.CapabilityRequest{
                TraceID:  req.TraceID,
                TenantID: req.TenantID,
                Type:     capgateway.CapSkill,
                Timeout:  30 * time.Second,
                Skill:    &capgateway.SkillCapRequest{SkillID: tc.Name, Input: tc.Arguments},
            })
            toolResult := formatToolResult(tc, toolResp, err)
            messages = append(messages, toolResult)
            allToolCalls = append(allToolCalls, tc)
        }
    }

    return nil, fmt.Errorf("react: max iterations reached: %d", req.AgentCfg.MaxIterations)
}

func callCapabilityActivity(ctx workflow.Context, req capgateway.CapabilityRequest) (capgateway.CapabilityResponse, error) {
    ao := workflow.ActivityOptions{
        StartToCloseTimeout: req.Timeout,
        RetryPolicy: &temporal.RetryPolicy{
            MaximumAttempts:    3,
            InitialInterval:    100 * time.Millisecond,
            BackoffCoefficient: 2.0,
        },
    }
    actCtx := workflow.WithActivityOptions(ctx, ao)
    var resp capgateway.CapabilityResponse
    err := workflow.ExecuteActivity(actCtx, activity.RegisterOptions{Name: ExecuteCapabilityActivityName}, req).Get(actCtx, &resp)
    return resp, err
}

func buildInitialMessages(cfg AgentWorkflowConfig, input string) []capgateway.LLMMessage {
    msgs := make([]capgateway.LLMMessage, 0, 2)
    if cfg.SystemPrompt != "" {
        msgs = append(msgs, capgateway.LLMMessage{Role: "system", Content: cfg.SystemPrompt})
    }
    msgs = append(msgs, capgateway.LLMMessage{Role: "user", Content: input})
    return msgs
}

func formatToolResult(tc capgateway.ToolCall, resp capgateway.CapabilityResponse, err error) capgateway.LLMMessage {
    content := ""
    if err != nil {
        content = fmt.Sprintf("error: %v", err)
    } else if resp.Output != nil {
        content = fmt.Sprintf("%v", resp.Output)
    }
    return capgateway.LLMMessage{
        Role:       "tool",
        Content:    content,
        ToolCallID: tc.ID,
    }
}

func maxIterations(n int) int {
    if n <= 0 {
        return 10
    }
    return n
}
```

- [ ] **Step 5: 运行确认通过**

```bash
go test ./internal/agent/workflow/... -v -race 2>&1 | tail -20
```

期望：`TestWorkflowSuite` 3 个子测试全部 `PASS`。

- [ ] **Step 6: go vet**

```bash
go vet ./internal/agent/workflow/... 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add internal/agent/workflow/
git commit -m "feat(workflow): implement ReActWorkflow and ExecuteCapabilityActivity"
```

---

## Task 10: BaseAgent 接入 Temporal Workflow

**Files:**

- Modify: `internal/agent/agent.go`

- [ ] **Step 1: 写失败测试**

在 `internal/agent/` 目录新增 `react_agent_test.go`：

```go
package agent_test

import (
    "context"
    "errors"
    "testing"

    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/workflow"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/stretchr/testify/require"
    "go.temporal.io/sdk/client"
    "go.uber.org/zap"
)

type mockWorkflowRun struct {
    result *workflow.ReActResult
    err    error
}

func (m *mockWorkflowRun) GetID() string                    { return "wf-id" }
func (m *mockWorkflowRun) GetRunID() string                 { return "run-id" }
func (m *mockWorkflowRun) Get(_ context.Context, v interface{}) error {
    if m.err != nil {
        return m.err
    }
    if ptr, ok := v.(**workflow.ReActResult); ok {
        *ptr = m.result
    }
    return nil
}
func (m *mockWorkflowRun) GetWithOptions(_ context.Context, _ interface{}, _ client.WorkflowRunGetOptions) error {
    return m.Get(nil, nil)
}

type mockTemporalClient struct {
    run client.WorkflowRun
    err error
}

func (m *mockTemporalClient) ExecuteWorkflow(_ context.Context, _ client.StartWorkflowOptions, _ interface{}, _ ...interface{}) (client.WorkflowRun, error) {
    return m.run, m.err
}

func TestBaseAgent_ReActExecute_DirectAnswer(t *testing.T) {
    cfg := &agent.AgentConfig{
        ID: "a1", Type: agent.ReActAgent,
        LLMModel: "qwen-turbo", MaxIterations: 5,
    }
    a := agent.NewBaseAgent(cfg, zap.NewNop())
    a.SetTemporalClient(&mockTemporalClient{
        run: &mockWorkflowRun{result: &workflow.ReActResult{Output: "hello", Steps: 1}},
    })
    a.SetCapGateway(&mockCapGateway{})

    result, err := a.Execute(context.Background(), "hi")
    require.NoError(t, err)
    require.Equal(t, "hello", result.Output)
}

func TestBaseAgent_ReActExecute_TemporalError(t *testing.T) {
    cfg := &agent.AgentConfig{ID: "a2", Type: agent.ReActAgent}
    a := agent.NewBaseAgent(cfg, zap.NewNop())
    a.SetTemporalClient(&mockTemporalClient{err: errors.New("temporal down")})
    a.SetCapGateway(&mockCapGateway{})

    _, err := a.Execute(context.Background(), "hi")
    require.Error(t, err)
}

type mockCapGateway struct{}
func (m *mockCapGateway) Route(_ context.Context, _ capgateway.CapabilityRequest) (capgateway.CapabilityResponse, error) {
    return capgateway.CapabilityResponse{}, nil
}
```

- [ ] **Step 2: 运行确认失败**

```bash
go test ./internal/agent/... -run "TestBaseAgent_ReAct" -v 2>&1 | tail -10
```

- [ ] **Step 3: 修改 agent.go**

1. 在 `BaseAgent` struct 中新增两个字段（在 `mu sync.Mutex` 之后）：

```go
TemporalClient TemporalWorkflowStarter
CapGateway     capgateway.CapabilityGateway
```

1. 在同文件中（或新文件）定义最小接口（避免 import cycle）：

```go
// TemporalWorkflowStarter is the minimal Temporal client interface BaseAgent needs.
type TemporalWorkflowStarter interface {
    ExecuteWorkflow(ctx context.Context, options temporalclient.StartWorkflowOptions,
        workflow interface{}, args ...interface{}) (temporalclient.WorkflowRun, error)
}
```

（import `go.temporal.io/sdk/client` as `temporalclient`）

1. 新增 setter：

```go
func (a *BaseAgent) SetTemporalClient(c TemporalWorkflowStarter) { a.TemporalClient = c }
func (a *BaseAgent) SetCapGateway(gw capgateway.CapabilityGateway) { a.CapGateway = gw }
```

1. 替换 `Execute()` 中的 `case ReActAgent:` 分支：

```go
case ReActAgent:
    if a.TemporalClient == nil || a.CapGateway == nil {
        execErr = fmt.Errorf("react agent not configured: temporal client or cap gateway is nil")
        break
    }
    wfReq := agentworkflow.ReActRequest{
        TraceID:  extractTraceID(ctx),
        TenantID: a.tenantIDFromCtx(ctx),
        AgentID:  a.ID,
        Input:    input,
        AgentCfg: agentworkflow.AgentWorkflowConfig{
            ID:            a.ID,
            Name:          a.Name,
            LLMModel:      a.LLMModel,
            SystemPrompt:  a.SystemPrompt,
            MaxIterations: cfg.MaxSteps,
        },
    }
    run, err := a.TemporalClient.ExecuteWorkflow(ctx,
        temporalclient.StartWorkflowOptions{
            ID:        fmt.Sprintf("react-%s-%d", a.ID, time.Now().UnixNano()),
            TaskQueue: agentworkflow.TaskQueue,
        },
        agentworkflow.ReActWorkflow,
        wfReq,
    )
    if err != nil {
        execErr = fmt.Errorf("react: submit workflow: %w", err)
        break
    }
    var wfResult *agentworkflow.ReActResult
    if err := run.Get(ctx, &wfResult); err != nil {
        execErr = fmt.Errorf("react: workflow: %w", err)
        break
    }
    result.Output = wfResult.Output
    result.Steps = wfResult.Steps
    for _, tc := range wfResult.ToolCalls {
        result.ToolCalls = append(result.ToolCalls, ToolCall{
            ToolName: tc.Name,
            Input:    tc.Arguments,
        })
    }
```

1. 在文件顶部添加所需 import：
   - `agentworkflow "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/workflow"`
   - `temporalclient "go.temporal.io/sdk/client"`
   - `"github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"`

2. 新增两个辅助函数（可为私有）：

```go
func extractTraceID(ctx context.Context) string {
    if v, ok := ctx.Value("trace_id").(string); ok {
        return v
    }
    return ""
}

func (a *BaseAgent) tenantIDFromCtx(ctx context.Context) string {
    if v, ok := ctx.Value("tenant_id").(string); ok {
        return v
    }
    return ""
}
```

- [ ] **Step 4: 运行确认通过**

```bash
go test ./internal/agent/... -run "TestBaseAgent_ReAct" -v 2>&1 | tail -15
```

- [ ] **Step 5: 运行全量 agent 测试**

```bash
go test ./internal/agent/... -v -race 2>&1 | tail -20
```

期望：全部 `PASS`，无 race。

- [ ] **Step 6: Commit**

```bash
git add internal/agent/agent.go internal/agent/react_agent_test.go
git commit -m "feat(agent): wire ReActAgent to Temporal workflow via BaseAgent.TemporalClient"
```

---

## Task 11: main.go——注册 Temporal Worker 到 Harness

**Files:**

- Modify: `cmd/server/main.go`

- [ ] **Step 1: 查看当前 main.go 组件注册顺序**

```bash
grep -n "Register\|harness\|Component" /home/yang/go-projects/ClawHermes-AI-Go/cmd/server/main.go | head -30
```

确认 `llmComponent` 和 `skill-registry` 已注册。

- [ ] **Step 2: 修改 main.go**

在 `llmComponent` 注册之后、`httpServer` 注册之前，插入：

```go
// capgateway
llmAdapter := capgateway.NewLLMAdapter(gateway, logger)
skillAdapter := capgateway.NewSkillAdapter(skillGW, logger)
capGW := capgateway.NewDefaultCapabilityGateway(llmAdapter, skillAdapter, logger)

// temporal worker
temporalWorker := agentworkflow.NewTemporalWorkerComponent(&cfg.Temporal, capGW, logger)
if err := appHarness.Register(temporalWorker); err != nil {
    logger.Fatal("failed to register temporal worker", zap.Error(err))
}
```

在 HTTP Server 的 router 初始化处，将 `temporalWorker.Client()` 传入（或通过 AgentHandler 的初始化）。

> **注意**：`router.SetupRouter` 目前只传 `cfg, logger, registry, gateway, pgPool.DB()`。需要检查 `AgentHandler` 的构造函数签名，判断是否需要新增参数传入 Temporal Client。若 `AgentHandler` 没有直接 `Execute` 而是通过 `registry.Get()` 拿到 `Agent` 实例再调用 `Execute()`，则只需要在 Registry 加载 agent 时注入 `TemporalClient`。

具体步骤：

1. 在 `main.go` 中 `appHarness.Start(ctx)` 之前（Harness Start 后 Temporal client 才可用），使用 `harness.GetComponent("temporal-worker")` 取回 client，并将其注入所有已注册 Agent。

示例伪代码（在 harness.Start 之后）：

```go
if err := appHarness.Start(ctx); err != nil {
    logger.Fatal("failed to start harness", zap.Error(err))
}

// inject temporal client into all registered agents
if twComp, ok := appHarness.GetComponent("temporal-worker"); ok {
    if tw, ok := twComp.(*agentworkflow.TemporalWorkerComponent); ok {
        registry.InjectTemporalClient(tw.Client(), capGW)
    }
}
```

- [ ] **Step 3: 给 Registry 添加 InjectTemporalClient**

在 `internal/agent/registry.go` 中新增方法（若 Registry 持有 agent 实例列表）：

```go
func (r *Registry) InjectTemporalClient(c TemporalWorkflowStarter, gw capgateway.CapabilityGateway) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    for _, a := range r.agents {
        if ba, ok := a.(*BaseAgent); ok {
            ba.SetTemporalClient(c)
            ba.SetCapGateway(gw)
        }
    }
}
```

- [ ] **Step 4: go build 确认编译通过**

```bash
go build ./cmd/server/... 2>&1
```

期望：无错误。

- [ ] **Step 5: go vet 全量**

```bash
go vet ./... 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add cmd/server/main.go internal/agent/registry.go
git commit -m "feat(server): register TemporalWorkerComponent in Harness, inject into agents"
```

---

## Task 12: Docker Compose——添加 Temporal 服务

**Files:**

- Modify: `docker-compose.yml`

- [ ] **Step 1: 确认现有 postgres service 名称**

```bash
grep -A5 "postgres:" /home/yang/go-projects/ClawHermes-AI-Go/docker-compose.yml | head -10
```

确认 service 名为 `postgres`，端口 5432。

- [ ] **Step 2: 在 docker-compose.yml 末尾追加 temporal 服务**

在文件末尾（`volumes:` 段之前）追加：

```yaml
  temporal:
    image: temporalio/auto-setup:1.24
    ports:
      - "7233:7233"
    environment:
      - DB=postgres12
      - DB_PORT=5432
      - POSTGRES_USER=${POSTGRES_USER:-clawhermes}
      - POSTGRES_PWD=${POSTGRES_PASSWORD:-clawhermes}
      - POSTGRES_SEEDS=postgres
    depends_on:
      - postgres
    networks:
      - clawhermes-network

  temporal-ui:
    image: temporalio/ui:2.26
    ports:
      - "8088:8080"
    environment:
      - TEMPORAL_ADDRESS=temporal:7233
    depends_on:
      - temporal
    networks:
      - clawhermes-network
```

> 确认 docker-compose.yml 中的 network 名称（通常为 `clawhermes-network` 或 `default`），根据实际替换。

- [ ] **Step 3: 验证 docker-compose 语法**

```bash
docker compose -f /home/yang/go-projects/ClawHermes-AI-Go/docker-compose.yml config --quiet 2>&1
```

期望：无报错。

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): add temporal and temporal-ui to docker-compose"
```

---

## Task 13: 全量验证

- [ ] **Step 1: go vet 全量**

```bash
go vet ./... 2>&1
```

期望：无输出。

- [ ] **Step 2: 全量单元测试（含 race）**

```bash
go test -race -timeout 60s ./internal/llmgateway/... ./internal/capgateway/... ./internal/agent/workflow/... ./internal/agent/... 2>&1 | tail -30
```

期望：全部 `PASS`，无 race。

- [ ] **Step 3: 覆盖率检查**

```bash
go test -cover ./internal/capgateway/... ./internal/agent/workflow/... 2>&1 | grep "coverage"
```

期望：capgateway ≥80%，workflow ≥80%。

- [ ] **Step 4: 完整构建**

```bash
go build ./... 2>&1
```

期望：无错误。

- [ ] **Step 5: 前端 lint（如前端有变动，本次无）**

本次无前端变更，跳过。

- [ ] **Step 6: 最终 Commit（若有遗漏文件）**

```bash
git status
git add -p  # 逐块确认
git commit -m "chore: final cleanup for temporal react agent integration"
```

---

## 自审检查结果

**Spec 覆盖率：**

| Spec 章节 | 计划任务 |
|-----------|---------|
| §5 LLMGateway 扩展 | Task 1 + Task 2 ✓ |
| §3 capgateway 类型 | Task 3 ✓ |
| §3 LLM Adapter | Task 4 ✓ |
| §3 Skill Adapter | Task 5 ✓ |
| §3 DefaultCapabilityGateway | Task 6 ✓ |
| §4 Activity DI | Task 9 ✓ |
| §4 ReActWorkflow | Task 9 ✓ |
| §6 Temporal Worker Harness 注册 | Task 8 + Task 11 ✓ |
| §6 Docker Compose | Task 12 ✓ |
| §6 Config 扩展 | Task 7 ✓ |
| BaseAgent 接入 | Task 10 ✓ |

**类型一致性检查：**

- `ToolCall.ID/Name/Arguments` 在 Task 3/4/9 中保持一致 ✓
- `LLMMessage.Role/Content/ToolCallID/ToolCalls` 在 Task 3/4/9 中保持一致 ✓
- `ExecuteCapabilityActivityName` 常量在 Task 9 定义、Task 9 workflow 使用 ✓
- `TaskQueue` 常量在 Task 8 定义、Task 10 使用 ✓

**Spec 与实现的已知差异：**

- `callCapabilityActivity` 使用 `activity.RegisterOptions{Name: ...}` 注册方式，需验证 Temporal Go SDK v1.x 的实际 API；若 API 不同，应改为直接传函数引用（`deps.ExecuteCapabilityActivity`）并依赖 Temporal 的函数名反射。在 Task 9 实施时须验证。
