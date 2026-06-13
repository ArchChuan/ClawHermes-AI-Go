# Temporal Client Timing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `TemporalWorkerComponent.Client()` 在 harness 启动前被调用返回 nil 的 timing bug，使 ReAct agent 在设置 API key 后能成功执行。

**Architecture:** 让 `*TemporalWorkerComponent` 实现 `agent.TemporalWorkflowStarter` 接口，新增 `ExecuteWorkflow` 方法委托给 `c.client`；`main.go` 改为传组件本身而非 `temporalWorker.Client()`。调用时 harness 已启动，`c.client` 已就绪，消除 nil 问题。

**Tech Stack:** Go 1.22, `go.temporal.io/sdk v1.x`, `go.temporal.io/sdk/client`, `go.temporal.io/sdk/worker`

---

## Task 1: 为 `TemporalWorkerComponent` 添加 `ExecuteWorkflow` 方法

**Files:**

- Modify: `internal/agent/workflow/worker.go`
- Test: `internal/agent/workflow/worker_test.go`（新建）

- [ ] **Step 1: 写失败测试**

在 `internal/agent/workflow/worker_test.go` 创建：

```go
package workflow_test

import (
 "context"
 "testing"

 "github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent/workflow"
 "github.com/byteBuilderX/ClawHermes-AI-Go/internal/config"
 "github.com/stretchr/testify/assert"
)

func TestTemporalWorkerComponent_ExecuteWorkflow_NilClient(t *testing.T) {
 cfg := &config.TemporalConfig{HostPort: "localhost:7233"}
 comp := workflow.NewTemporalWorkerComponent(cfg, nil, nil)
 _, err := comp.ExecuteWorkflow(context.Background(), nil, nil)
 assert.ErrorContains(t, err, "client not initialized")
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
go test -v -run TestTemporalWorkerComponent_ExecuteWorkflow_NilClient ./internal/agent/workflow/...
```

期望：`FAIL` — `comp.ExecuteWorkflow undefined`

- [ ] **Step 3: 在 `worker.go` 添加 `ExecuteWorkflow` 方法**

在 `internal/agent/workflow/worker.go` 末尾追加（`Stop` 方法之后）：

```go
// ExecuteWorkflow implements agent.TemporalWorkflowStarter.
// Delegates to the underlying Temporal client initialized in Start().
func (c *TemporalWorkerComponent) ExecuteWorkflow(
 ctx context.Context,
 options client.StartWorkflowOptions,
 workflow interface{},
 args ...interface{},
) (client.WorkflowRun, error) {
 if c.client == nil {
  return nil, fmt.Errorf("temporal-worker: client not initialized (worker not started)")
 }
 return c.client.ExecuteWorkflow(ctx, options, workflow, args...)
}
```

确认 `worker.go` 顶部 import 中已有 `"go.temporal.io/sdk/client"`（已有，无需添加）。

- [ ] **Step 4: 运行测试确认通过**

```bash
go test -v -run TestTemporalWorkerComponent_ExecuteWorkflow_NilClient ./internal/agent/workflow/...
```

期望：`PASS`

- [ ] **Step 5: 运行全 workflow 包测试**

```bash
go test -race -v ./internal/agent/workflow/...
```

期望：所有测试通过，无 race condition。

- [ ] **Step 6: Commit**

```bash
git add internal/agent/workflow/worker.go internal/agent/workflow/worker_test.go
git commit -m "feat(workflow): TemporalWorkerComponent implements TemporalWorkflowStarter"
```

---

## Task 2: `main.go` 传组件本身代替 `Client()`

**Files:**

- Modify: `cmd/server/main.go`

- [ ] **Step 1: 修改 `SetupRouter` 调用**

在 `cmd/server/main.go` 找到：

```go
router := api.SetupRouter(cfg, logger, registry, gateway, pgPool.DB(), redisClient.Client(), temporalWorker.Client())
```

改为：

```go
router := api.SetupRouter(cfg, logger, registry, gateway, pgPool.DB(), redisClient.Client(), temporalWorker)
```

- [ ] **Step 2: 编译确认**

```bash
go build ./cmd/server/...
```

期望：编译成功，无错误。若报类型不匹配，检查 `*TemporalWorkerComponent` 是否正确实现了 `agent.TemporalWorkflowStarter` 的所有方法（Task 1 的 `ExecuteWorkflow` 签名需与接口完全一致）。

- [ ] **Step 3: 运行全量测试**

```bash
go test -race -timeout 60s ./...
```

期望：所有包通过。

- [ ] **Step 4: Commit**

```bash
git add cmd/server/main.go
git commit -m "fix(main): pass temporalWorker component instead of nil Client() to SetupRouter"
```

---

## Task 3: 验证接口满足的编译期检查

**Files:**

- Modify: `internal/agent/workflow/worker.go`

- [ ] **Step 1: 添加编译期断言**

在 `worker.go` 的 `var` 块或 import 块后添加：

```go
var _ agent.TemporalWorkflowStarter = (*TemporalWorkerComponent)(nil)
```

同时在 import 中确认引入：

```go
"github.com/byteBuilderX/ClawHermes-AI-Go/internal/agent"
```

- [ ] **Step 2: 编译确认断言生效**

```bash
go build ./internal/agent/workflow/...
```

期望：编译成功。如果接口不满足，编译器会立即报错。

- [ ] **Step 3: 运行全 workflow 包测试**

```bash
go test -race ./internal/agent/workflow/...
```

期望：通过。

- [ ] **Step 4: Commit**

```bash
git add internal/agent/workflow/worker.go
git commit -m "chore(workflow): add compile-time interface assertion for TemporalWorkflowStarter"
```

---

## Task 4: 端到端冒烟测试

**前提：** Temporal server 已运行（`docker compose up temporal`），且设置了 `QWEN_API_KEY` 或 `ZHIPU_API_KEY`。

- [ ] **Step 1: 启动服务**

```bash
QWEN_API_KEY=<your-key> go run ./cmd/server/...
```

期望：日志出现 `temporal worker started`，无 panic。

- [ ] **Step 2: 创建 ReAct agent**

```bash
curl -s -X POST http://localhost:8080/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-test","type":"react","llm_model":"qwen-turbo","max_iterations":3}' | jq .
```

期望：返回包含 `"id"` 的 JSON。

- [ ] **Step 3: 执行 agent**

```bash
curl -s -X POST http://localhost:8080/agents/<agent-id>/execute \
  -H "Content-Type: application/json" \
  -d '{"input":"用一句话介绍你自己"}' | jq .
```

期望：返回包含 `"output"` 字段的 JSON，内容为模型回复，不再返回 `TemporalClient is nil` 错误。
