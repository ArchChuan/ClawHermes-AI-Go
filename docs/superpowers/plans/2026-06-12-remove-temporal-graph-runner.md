# Remove Temporal & Self-Implement Graph Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 go.temporal.io/sdk 全部依赖，用自研 StateGraph[S] 替换 agent loop，复用现有 capgateway/llmgateway。

**Architecture:** 在 `internal/agent/graph/` 实现 4 个文件（graph.go, runner.go, retry.go, react.go）构成轻量图运行时；修改 agent.go 让 ReActAgent case 直接调用 `BuildReActGraph` + `Invoke`；删除整个 `internal/agent/workflow/` 目录及所有 Temporal 引用。

**Tech Stack:** Go 1.22 generics · golang.org/x/sync/semaphore · capgateway.CapabilityGateway

---

## Task 1: graph 核心原语 `internal/agent/graph/graph.go`

**Files:**

- Create: `internal/agent/graph/graph.go`
- Test: `internal/agent/graph/graph_test.go`

**Step 1: Write the failing test**

```go
// internal/agent/graph/graph_test.go
package graph_test

import (
    "context"
    "errors"
    "testing"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/graph"
    "github.com/stretchr/testify/require"
)

type counter struct{ N int }

func inc(ctx context.Context, s counter) (counter, error) { s.N++; return s, nil }
func boom(_ context.Context, s counter) (counter, error)  { return s, errors.New("boom") }

func TestStateGraph_HappyPath(t *testing.T) {
    g := graph.New[counter]()
    g.AddNode("inc", inc)
    g.AddEdge("inc", graph.END)
    g.SetEntryPoint("inc")
    cg, err := g.Compile()
    require.NoError(t, err)
    out, err := cg.Invoke(context.Background(), counter{}, graph.RunConfig{MaxSteps: 5})
    require.NoError(t, err)
    require.Equal(t, 1, out.N)
}

func TestStateGraph_ConditionalEdge(t *testing.T) {
    g := graph.New[counter]()
    g.AddNode("inc", inc)
    g.AddConditionalEdge("inc", func(s counter) string {
        if s.N < 3 { return "inc" }
        return graph.END
    })
    g.SetEntryPoint("inc")
    cg, _ := g.Compile()
    out, err := cg.Invoke(context.Background(), counter{}, graph.RunConfig{MaxSteps: 10})
    require.NoError(t, err)
    require.Equal(t, 3, out.N)
}

func TestStateGraph_MaxSteps(t *testing.T) {
    g := graph.New[counter]()
    g.AddNode("inc", inc)
    g.AddEdge("inc", "inc")
    g.SetEntryPoint("inc")
    cg, _ := g.Compile()
    _, err := cg.Invoke(context.Background(), counter{}, graph.RunConfig{MaxSteps: 3})
    require.Error(t, err)
    require.Contains(t, err.Error(), "max steps")
}

func TestStateGraph_NodeError(t *testing.T) {
    g := graph.New[counter]()
    g.AddNode("boom", boom)
    g.AddEdge("boom", graph.END)
    g.SetEntryPoint("boom")
    cg, _ := g.Compile()
    _, err := cg.Invoke(context.Background(), counter{}, graph.RunConfig{MaxSteps: 5})
    require.ErrorContains(t, err, "boom")
}

func TestStateGraph_PanicRecovery(t *testing.T) {
    g := graph.New[counter]()
    g.AddNode("panic", func(_ context.Context, s counter) (counter, error) { panic("oh no") })
    g.AddEdge("panic", graph.END)
    g.SetEntryPoint("panic")
    cg, _ := g.Compile()
    _, err := cg.Invoke(context.Background(), counter{}, graph.RunConfig{MaxSteps: 5})
    require.ErrorContains(t, err, "panic")
}

func TestStateGraph_CompileErrors(t *testing.T) {
    _, err := graph.New[counter]().Compile()
    require.ErrorContains(t, err, "entry point")

    g2 := graph.New[counter]()
    g2.SetEntryPoint("missing")
    _, err = g2.Compile()
    require.ErrorContains(t, err, "not registered")
}
```

**Step 2: Run test to verify it fails**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test ./internal/agent/graph/... 2>&1 | head -20`

Expected: FAIL — package does not exist

**Step 3: Write implementation**

```go
// internal/agent/graph/graph.go
package graph

import (
    "context"
    "fmt"
    "runtime/debug"
)

const END = "__end__"

type NodeFunc[S any] func(ctx context.Context, state S) (S, error)
type EdgeFunc[S any] func(state S) string

type StateGraph[S any] struct {
    nodes     map[string]NodeFunc[S]
    edges     map[string]string
    condEdges map[string]EdgeFunc[S]
    entry     string
}

func New[S any]() *StateGraph[S] {
    return &StateGraph[S]{
        nodes:     make(map[string]NodeFunc[S]),
        edges:     make(map[string]string),
        condEdges: make(map[string]EdgeFunc[S]),
    }
}

func (g *StateGraph[S]) AddNode(name string, fn NodeFunc[S]) *StateGraph[S] {
    g.nodes[name] = fn
    return g
}

func (g *StateGraph[S]) AddEdge(from, to string) *StateGraph[S] {
    g.edges[from] = to
    return g
}

func (g *StateGraph[S]) AddConditionalEdge(from string, fn EdgeFunc[S]) *StateGraph[S] {
    g.condEdges[from] = fn
    return g
}

func (g *StateGraph[S]) SetEntryPoint(name string) *StateGraph[S] {
    g.entry = name
    return g
}

type CompiledGraph[S any] struct{ g *StateGraph[S] }

type RunConfig struct {
    MaxSteps int
}

func (g *StateGraph[S]) Compile() (*CompiledGraph[S], error) {
    if g.entry == "" {
        return nil, fmt.Errorf("graph: entry point not set")
    }
    if _, ok := g.nodes[g.entry]; !ok {
        return nil, fmt.Errorf("graph: entry node %q not registered", g.entry)
    }
    return &CompiledGraph[S]{g: g}, nil
}

func (c *CompiledGraph[S]) Invoke(ctx context.Context, initial S, cfg RunConfig) (S, error) {
    maxSteps := cfg.MaxSteps
    if maxSteps <= 0 {
        maxSteps = 10
    }
    state := initial
    current := c.g.entry
    for step := 0; step < maxSteps; step++ {
        if current == END {
            return state, nil
        }
        nodeFn, ok := c.g.nodes[current]
        if !ok {
            return state, fmt.Errorf("graph: node %q not found", current)
        }
        var execErr error
        func() {
            defer func() {
                if r := recover(); r != nil {
                    execErr = fmt.Errorf("graph: node %q panic: %v\n%s", current, r, debug.Stack())
                }
            }()
            state, execErr = nodeFn(ctx, state)
        }()
        if execErr != nil {
            return state, execErr
        }
        if condFn, ok := c.g.condEdges[current]; ok {
            current = condFn(state)
        } else if next, ok := c.g.edges[current]; ok {
            current = next
        } else {
            return state, fmt.Errorf("graph: no outgoing edge from node %q", current)
        }
    }
    return state, fmt.Errorf("graph: max steps reached: %d", maxSteps)
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test ./internal/agent/graph/... -v -count=1`

Expected: PASS all 6 tests

- [ ] **Step 5: Commit**

```bash
git add internal/agent/graph/graph.go internal/agent/graph/graph_test.go
git commit -m "feat(agent/graph): add StateGraph[S] generic graph runner"
```

---

## Task 2: retry 工具 `internal/agent/graph/retry.go`

**Files:**

- Create: `internal/agent/graph/retry.go`
- Test: `internal/agent/graph/retry_test.go`

**Step 1: Write the failing test**

```go
// internal/agent/graph/retry_test.go
package graph_test

import (
    "context"
    "errors"
    "testing"
    "time"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/graph"
    "github.com/stretchr/testify/require"
)

func TestRetryFn_SuccessFirstTry(t *testing.T) {
    calls := 0
    result, err := graph.RetryFn(context.Background(), graph.DefaultRetry, func() (string, error) {
        calls++
        return "ok", nil
    })
    require.NoError(t, err)
    require.Equal(t, "ok", result)
    require.Equal(t, 1, calls)
}

func TestRetryFn_SuccessOnThirdTry(t *testing.T) {
    calls := 0
    result, err := graph.RetryFn(context.Background(), graph.RetryConfig{Attempts: 3, Base: time.Millisecond, Max: 10 * time.Millisecond}, func() (int, error) {
        calls++
        if calls < 3 { return 0, errors.New("transient") }
        return 42, nil
    })
    require.NoError(t, err)
    require.Equal(t, 42, result)
    require.Equal(t, 3, calls)
}

func TestRetryFn_AllFail(t *testing.T) {
    calls := 0
    _, err := graph.RetryFn(context.Background(), graph.RetryConfig{Attempts: 3, Base: time.Millisecond, Max: 10 * time.Millisecond}, func() (int, error) {
        calls++
        return 0, errors.New("permanent")
    })
    require.ErrorContains(t, err, "permanent")
    require.Equal(t, 3, calls)
}

func TestRetryFn_CancelledContext(t *testing.T) {
    ctx, cancel := context.WithCancel(context.Background())
    cancel()
    _, err := graph.RetryFn(ctx, graph.RetryConfig{Attempts: 3, Base: time.Millisecond, Max: 10 * time.Millisecond}, func() (int, error) {
        return 0, errors.New("fail")
    })
    require.Error(t, err)
}
```

**Step 2: Run test to verify it fails**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test ./internal/agent/graph/... -run TestRetry 2>&1`

Expected: FAIL — RetryFn undefined

**Step 3: Write implementation**

```go
// internal/agent/graph/retry.go
package graph

import (
    "context"
    "errors"
    "time"
)

type RetryConfig struct {
    Attempts int
    Base     time.Duration
    Max      time.Duration
}

var DefaultRetry = RetryConfig{Attempts: 3, Base: 100 * time.Millisecond, Max: 10 * time.Second}

func RetryFn[T any](ctx context.Context, cfg RetryConfig, fn func() (T, error)) (T, error) {
    var zero T
    delay := cfg.Base
    var lastErr error
    for i := 0; i < cfg.Attempts; i++ {
        result, err := fn()
        if err == nil {
            return result, nil
        }
        lastErr = err
        if i < cfg.Attempts-1 {
            select {
            case <-ctx.Done():
                return zero, errors.Join(lastErr, ctx.Err())
            case <-time.After(delay):
            }
            delay *= 2
            if delay > cfg.Max {
                delay = cfg.Max
            }
        }
    }
    return zero, lastErr
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test ./internal/agent/graph/... -v -count=1`

Expected: PASS all tests

- [ ] **Step 5: Commit**

```bash
git add internal/agent/graph/retry.go internal/agent/graph/retry_test.go
git commit -m "feat(agent/graph): add generic RetryFn with exponential backoff"
```

---

## Task 3: ReAct graph `internal/agent/graph/react.go`

**Files:**

- Create: `internal/agent/graph/react.go`
- Test: `internal/agent/graph/react_test.go`

**Step 1: Write the failing test**

```go
// internal/agent/graph/react_test.go
package graph_test

import (
    "context"
    "testing"
    "time"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/graph"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
    "github.com/stretchr/testify/require"
)

// stubCapGW implements capgateway.CapabilityGateway for tests.
type stubCapGW struct {
    llmResp  capgateway.CapabilityResponse
    toolResp capgateway.CapabilityResponse
    llmErr   error
    toolErr  error
    calls    []capgateway.CapabilityRequest
}

func (s *stubCapGW) Route(_ context.Context, req capgateway.CapabilityRequest) (capgateway.CapabilityResponse, error) {
    s.calls = append(s.calls, req)
    if req.Type == capgateway.CapLLM {
        return s.llmResp, s.llmErr
    }
    return s.toolResp, s.toolErr
}

func TestBuildReActGraph_DirectAnswer(t *testing.T) {
    stub := &stubCapGW{
        llmResp: capgateway.CapabilityResponse{Content: "42"},
    }
    cg, err := graph.BuildReActGraph(stub)
    require.NoError(t, err)

    state := graph.ReActState{
        TenantID:     "t1",
        Model:        "qwen-turbo",
        SystemPrompt: "You are helpful.",
        Messages:     []capgateway.LLMMessage{{Role: "user", Content: "what is 6x7?"}},
    }
    out, err := cg.Invoke(context.Background(), state, graph.RunConfig{MaxSteps: 5})
    require.NoError(t, err)
    require.Equal(t, "42", out.Output)
    require.Equal(t, 1, out.Steps)
    require.Len(t, stub.calls, 1)
}

func TestBuildReActGraph_ToolCall(t *testing.T) {
    callCount := 0
    stub := &stubCapGW{}
    // First LLM call returns tool call; second returns direct answer.
    stub2 := &capGWSequence{responses: []capgateway.CapabilityResponse{
        {ToolCalls: []capgateway.ToolCall{{ID: "c1", Name: "calc", Arguments: map[string]any{"expr": "6*7"}}}},
        {Content: "The answer is 42"},
    }, toolResp: capgateway.CapabilityResponse{Content: "42"}}
    _ = stub
    _ = callCount

    cg, err := graph.BuildReActGraph(stub2)
    require.NoError(t, err)

    state := graph.ReActState{
        Model:    "qwen-turbo",
        Messages: []capgateway.LLMMessage{{Role: "user", Content: "calc 6*7"}},
    }
    out, err := cg.Invoke(context.Background(), state, graph.RunConfig{MaxSteps: 10})
    require.NoError(t, err)
    require.Equal(t, "The answer is 42", out.Output)
    require.Equal(t, 2, out.Steps)
    require.Len(t, out.AllToolCalls, 1)
}

func TestBuildReActGraph_MaxIterations(t *testing.T) {
    // LLM always returns tool call → loop forever until max steps
    stub := &capGWSequence{
        infinite: capgateway.CapabilityResponse{
            ToolCalls: []capgateway.ToolCall{{ID: "c1", Name: "noop", Arguments: map[string]any{}}},
        },
        toolResp: capgateway.CapabilityResponse{Content: "ok"},
    }
    cg, _ := graph.BuildReActGraph(stub)
    state := graph.ReActState{
        Model:    "qwen-turbo",
        Messages: []capgateway.LLMMessage{{Role: "user", Content: "loop"}},
    }
    _, err := cg.Invoke(context.Background(), state, graph.RunConfig{MaxSteps: 4})
    require.ErrorContains(t, err, "max steps")
}

func TestBuildReActGraph_LLMError(t *testing.T) {
    stub := &stubCapGW{llmErr: context.DeadlineExceeded}
    cg, _ := graph.BuildReActGraph(stub)
    state := graph.ReActState{
        Model:    "qwen-turbo",
        Messages: []capgateway.LLMMessage{{Role: "user", Content: "hi"}},
    }
    _, err := cg.Invoke(context.Background(), state, graph.RunConfig{MaxSteps: 5})
    require.Error(t, err)
}

func TestBuildReActGraph_ContextTimeout(t *testing.T) {
    stub := &slowCapGW{delay: 200 * time.Millisecond}
    cg, _ := graph.BuildReActGraph(stub)
    ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
    defer cancel()
    state := graph.ReActState{
        Model:    "qwen-turbo",
        Messages: []capgateway.LLMMessage{{Role: "user", Content: "hi"}},
    }
    _, err := cg.Invoke(ctx, state, graph.RunConfig{MaxSteps: 5})
    require.Error(t, err)
}

// capGWSequence drives LLM responses in sequence; tool always returns fixed resp.
type capGWSequence struct {
    responses []capgateway.CapabilityResponse
    idx       int
    infinite  capgateway.CapabilityResponse // non-zero means always return this after sequence exhausted
    toolResp  capgateway.CapabilityResponse
}

func (s *capGWSequence) Route(_ context.Context, req capgateway.CapabilityRequest) (capgateway.CapabilityResponse, error) {
    if req.Type == capgateway.CapSkill {
        return s.toolResp, nil
    }
    if s.idx < len(s.responses) {
        r := s.responses[s.idx]
        s.idx++
        return r, nil
    }
    return s.infinite, nil
}

type slowCapGW struct{ delay time.Duration }

func (s *slowCapGW) Route(ctx context.Context, _ capgateway.CapabilityRequest) (capgateway.CapabilityResponse, error) {
    select {
    case <-ctx.Done():
        return capgateway.CapabilityResponse{}, ctx.Err()
    case <-time.After(s.delay):
        return capgateway.CapabilityResponse{Content: "slow"}, nil
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test ./internal/agent/graph/... -run TestBuildReActGraph 2>&1`

Expected: FAIL — BuildReActGraph undefined

**Step 3: Write implementation**

```go
// internal/agent/graph/react.go
package graph

import (
    "context"
    "fmt"
    "time"
    "github.com/byteBuilderX/ClawHermes-AI-Go/internal/capgateway"
)

const (
    nodeLLM  = "llm"
    nodeTool = "tool"
)

// ReActState is the mutable state threaded through the ReAct graph.
type ReActState struct {
    TenantID       string
    TraceID        string
    LLMAPIKeys     map[string]string
    Model          string
    SystemPrompt   string
    AvailableTools []capgateway.ToolDefinition
    Messages       []capgateway.LLMMessage
    AllToolCalls   []capgateway.ToolCall
    Output         string
    Steps          int
}

// BuildReActGraph constructs and compiles the ReAct agent graph.
func BuildReActGraph(capGW capgateway.CapabilityGateway) (*CompiledGraph[ReActState], error) {
    g := New[ReActState]()
    g.AddNode(nodeLLM, makeLLMNode(capGW))
    g.AddNode(nodeTool, makeToolNode(capGW))
    g.AddConditionalEdge(nodeLLM, func(s ReActState) string {
        if len(s.Messages) == 0 {
            return END
        }
        last := s.Messages[len(s.Messages)-1]
        if last.Role == "assistant" && len(last.ToolCalls) > 0 {
            return nodeTool
        }
        return END
    })
    g.AddEdge(nodeTool, nodeLLM)
    g.SetEntryPoint(nodeLLM)
    return g.Compile()
}

func makeLLMNode(capGW capgateway.CapabilityGateway) NodeFunc[ReActState] {
    return func(ctx context.Context, s ReActState) (ReActState, error) {
        resp, err := RetryFn(ctx, DefaultRetry, func() (capgateway.CapabilityResponse, error) {
            return capGW.Route(ctx, capgateway.CapabilityRequest{
                TraceID:    s.TraceID,
                TenantID:   s.TenantID,
                Type:       capgateway.CapLLM,
                Timeout:    60 * time.Second,
                LLMAPIKeys: s.LLMAPIKeys,
                LLM: &capgateway.LLMCapRequest{
                    Model:    s.Model,
                    Messages: s.Messages,
                    Tools:    s.AvailableTools,
                },
            })
        })
        if err != nil {
            return s, fmt.Errorf("react llm node: %w", err)
        }
        s.Steps++
        if len(resp.ToolCalls) == 0 {
            s.Output = resp.Content
            s.Messages = append(s.Messages, capgateway.LLMMessage{
                Role:    "assistant",
                Content: resp.Content,
            })
        } else {
            s.Messages = append(s.Messages, capgateway.LLMMessage{
                Role:      "assistant",
                ToolCalls: resp.ToolCalls,
            })
        }
        return s, nil
    }
}

func makeToolNode(capGW capgateway.CapabilityGateway) NodeFunc[ReActState] {
    return func(ctx context.Context, s ReActState) (ReActState, error) {
        if len(s.Messages) == 0 {
            return s, nil
        }
        last := s.Messages[len(s.Messages)-1]
        for _, tc := range last.ToolCalls {
            toolResp, err := capGW.Route(ctx, capgateway.CapabilityRequest{
                TraceID:  s.TraceID,
                TenantID: s.TenantID,
                Type:     capgateway.CapSkill,
                Timeout:  30 * time.Second,
                Skill:    &capgateway.SkillCapRequest{SkillID: tc.Name, Input: tc.Arguments},
            })
            content := ""
            if err != nil {
                content = fmt.Sprintf("error: %v", err)
            } else if toolResp.Output != nil {
                content = fmt.Sprintf("%v", toolResp.Output)
            } else {
                content = toolResp.Content
            }
            s.Messages = append(s.Messages, capgateway.LLMMessage{
                Role:       "tool",
                Content:    content,
                ToolCallID: tc.ID,
            })
            s.AllToolCalls = append(s.AllToolCalls, tc)
        }
        return s, nil
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test ./internal/agent/graph/... -v -count=1`

Expected: PASS all tests

- [ ] **Step 5: Commit**

```bash
git add internal/agent/graph/react.go internal/agent/graph/react_test.go
git commit -m "feat(agent/graph): add ReAct graph with LLM + tool nodes"
```

---

## Task 4: 修改 `internal/agent/agent.go` — 移除 Temporal，接入图运行时

**Files:**

- Modify: `internal/agent/agent.go`

**Step 1: 验证当前测试状态**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test ./internal/agent/... -count=1 2>&1 | tail -10`

Expected: 当前测试依赖 Temporal mock，记录状态

**Step 2: 修改 agent.go**

变更内容：

1. 删除 `TemporalWorkflowStarter` interface
2. 删除 `BaseAgent.TemporalClient` 字段
3. 删除 `SetTemporalClient` 方法
4. 删除 `agentworkflow` import，删除 `temporalclient` import
5. 在 `ReActAgent` case：调用 `agentgraph.BuildReActGraph` + `cg.Invoke`
6. 保留 `SetCapGateway`，`CapGateway` 字段

关键逻辑：

```go
case ReActAgent:
    if a.CapGateway == nil {
        execErr = fmt.Errorf("react: CapGateway not set")
        break
    }
    cg, buildErr := agentgraph.BuildReActGraph(a.CapGateway)
    if buildErr != nil {
        execErr = fmt.Errorf("react: build graph: %w", buildErr)
        break
    }
    initMessages := make([]capgateway.LLMMessage, 0, 2)
    if a.SystemPrompt != "" {
        initMessages = append(initMessages, capgateway.LLMMessage{Role: "system", Content: a.SystemPrompt})
    }
    initMessages = append(initMessages, capgateway.LLMMessage{Role: "user", Content: input})

    initState := agentgraph.ReActState{
        TenantID:   cfg.TenantID,
        LLMAPIKeys: cfg.LLMAPIKeys,
        Model:      a.LLMModel,
        Messages:   initMessages,
    }
    execCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
    defer cancel()

    finalState, runErr := cg.Invoke(execCtx, initState, agentgraph.RunConfig{MaxSteps: cfg.MaxSteps})
    if runErr != nil {
        execErr = fmt.Errorf("react: %w", runErr)
        break
    }
    result.Output = finalState.Output
    result.Steps = finalState.Steps
    // 记录 ToolCalls 到 result (内部类型转换)
    for _, tc := range finalState.AllToolCalls {
        result.ToolCalls = append(result.ToolCalls, ToolCall{
            ToolName: tc.Name,
            Input:    tc.Arguments,
        })
    }
```

注意：`result.Steps = a.State.StepsTaken` 在最后会覆盖 result.Steps，需改为只在 CoT 中使用 a.State，ReAct 直接 break 前设置后不应被覆盖。检查行 350：`result.Steps = a.State.StepsTaken` —— 需改为：仅在 CoT 中设置 `a.State.StepsTaken`；ReAct case 直接 set `result.Steps = finalState.Steps` 并 `break`，外部不再覆盖。

最简方案：在 switch 后的 `result.Steps = a.State.StepsTaken` 改为只在非 ReAct 时设置，或者保持 ReAct case 里自己 set 后再 skip。**更简单**：ReAct case 在 break 前设 `a.State.StepsTaken = finalState.Steps`，这样外部赋值正确。

**Step 3: 运行构建**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go build ./internal/agent/... 2>&1`

Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add internal/agent/agent.go
git commit -m "feat(agent): replace Temporal ReAct with graph runner"
```

---

## Task 5: 修改 `internal/agent/registry.go` — 移除 temporalClient

**Files:**

- Modify: `internal/agent/registry.go`

**Step 1: 修改**

变更内容：

1. 删除 `temporalClient TemporalWorkflowStarter` 字段
2. 删除 `SetTemporalClient` 方法
3. 在 `Get` 和 `GetAll` 中删除 `if r.temporalClient != nil { a.SetTemporalClient(...) }` 块
4. 添加 `capGW capgateway.CapabilityGateway` 字段
5. 添加 `SetCapGateway(gw capgateway.CapabilityGateway)` 方法
6. 在 `Get` 和 `GetAll` 中添加 `if r.capGW != nil { a.SetCapGateway(r.capGW) }`

**Step 2: 构建**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go build ./internal/agent/... 2>&1`

- [ ] **Step 3: Commit**

```bash
git add internal/agent/registry.go
git commit -m "refactor(agent): registry uses capGW injection, remove temporal client"
```

---

## Task 6: 修改 `api/router.go` — 移除 temporalClient 参数

**Files:**

- Modify: `api/router.go`
- Modify: `cmd/server/main.go`

**Step 1: 修改 router.go**

在 `SetupRouter` 签名中删除 `temporalClient agent.TemporalWorkflowStarter` 参数，删除函数体中的：

```go
if temporalClient != nil {
    agentRegistry.SetTemporalClient(temporalClient)
}
```

替换为：

```go
if capGW != nil {
    agentRegistry.SetCapGateway(capGW)
}
```

（需在 SetupRouter 参数中加入 `capGW capgateway.CapabilityGateway`，或复用已有参数）

查看 SetupRouter 实际参数后确认最小修改。

**Step 2: 修改 cmd/server/main.go**

删除：

```go
var _ agentpkg.TemporalWorkflowStarter = (*agentworkflow.TemporalWorkerComponent)(nil)
```

删除 `agentworkflow` import。
删除：

```go
temporalWorker := agentworkflow.NewTemporalWorkerComponent(&cfg.Temporal, capGW, logger)
if err := appHarness.Register(temporalWorker); err != nil {
    logger.Fatal("Failed to register Temporal Worker component", zap.Error(err))
}
```

修改 `api.SetupRouter(...)` 调用，移除 `temporalWorker` 参数。

**Step 3: 构建**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go build ./... 2>&1`

- [ ] **Step 4: Commit**

```bash
git add api/router.go cmd/server/main.go
git commit -m "refactor(api,cmd): remove temporal worker from router and main"
```

---

## Task 7: 修改 `internal/config/config.go` — 移除 TemporalConfig

**Files:**

- Modify: `internal/config/config.go`

**Step 1: 修改**

删除 `TemporalConfig` struct，删除 `Config.Temporal TemporalConfig` 字段，删除 `Load()` 中的 `Temporal: TemporalConfig{...}` 块。

**Step 2: 构建**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go build ./... 2>&1`

- [ ] **Step 3: Commit**

```bash
git add internal/config/config.go
git commit -m "chore(config): remove TemporalConfig"
```

---

## Task 8: 删除 `internal/agent/workflow/` 目录

**Files:**

- Delete: `internal/agent/workflow/` (entire directory)

**Step 1: 删除**

Run: `rm -rf /home/yang/go-projects/ClawHermes-AI-Go/internal/agent/workflow`

**Step 2: 构建验证**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go build ./... 2>&1`

Expected: PASS（无 workflow 引用残留）

- [ ] **Step 3: Commit**

```bash
git add -A internal/agent/workflow
git commit -m "chore(agent): delete internal/agent/workflow (Temporal removed)"
```

---

## Task 9: 重写 `internal/agent/react_agent_test.go`

**Files:**

- Modify: `internal/agent/react_agent_test.go`

**Step 1: 重写测试**

新测试直接 mock `capgateway.CapabilityGateway`，不涉及 Temporal。
测试用例：

- `TestBaseAgent_ReActExecute_DirectAnswer` — CapGateway 返回无工具调用的 LLM 响应
- `TestBaseAgent_ReActExecute_WithToolCall` — 一次工具调用后 LLM 返回最终答案
- `TestBaseAgent_ReActExecute_CapGWNil` — CapGateway 未设置时返回 error
- `TestBaseAgent_ReActExecute_LLMError` — CapGateway.Route 返回 error
- `TestBaseAgent_SetCapGateway_DataRace` — 并发 Set + Execute 无 data race

**Step 2: 运行测试**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test -race ./internal/agent/... -v -count=1 2>&1`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add internal/agent/react_agent_test.go
git commit -m "test(agent): rewrite react_agent_test to mock CapGateway directly"
```

---

## Task 10: go mod tidy + 清理配置

**Files:**

- Modify: `go.mod`, `go.sum`
- Modify: `config/dev.yaml` (if exists, remove temporal block)

**Step 1: 清理依赖**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go mod tidy 2>&1`

Expected: `go.temporal.io/sdk` 和 `go.temporal.io/api` 从 go.mod 移除

**Step 2: 完整测试**

Run: `cd /home/yang/go-projects/ClawHermes-AI-Go && go test -race -timeout 60s ./... 2>&1`

Expected: PASS（所有包）

**Step 3: 清理 YAML**

如果 `config/dev.yaml` 中有 `temporal:` 块，删除该块。`config/prod.yaml` 禁止修改。

- [ ] **Step 4: Final commit**

```bash
git add go.mod go.sum config/dev.yaml
git commit -m "chore: go mod tidy, remove temporal deps; clean dev config"
```
