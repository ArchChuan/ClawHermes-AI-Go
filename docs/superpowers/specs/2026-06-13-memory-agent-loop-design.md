# Memory-Agent Loop 设计规范

**日期**: 2026-06-13
**分支**: feat/tenant-suspend-enforcement
**作者**: byteBuilderX

## 背景

当前代码存在三条并行的对话历史链，互不通信，导致 `Execute()` 每次从白纸开始，
跨请求上下文完全丢失。本文档定义修复方案和可扩展架构。

### 问题陈述

| 存储 | 写入点 | Execute() 是否读取 |
|------|--------|-------------------|
| `ChatStore`（PostgreSQL） | HTTP handler `AddMessage` | 从不 |
| `MemoryManager.shortTerm`（in-process buffer） | `AddToMemory()` | 从不 |
| `BaseAgent.Memory []Message`（in-process slice） | `AddToMemory()` | 从不 |

根因：`BaseAgent.Execute()` 在 `switch agentType` 前构造的
`initMessages = [system_prompt, user_input]` 完全忽略历史。

---

## 架构决策

### 角色重新分配

**ChatStore = 短期记忆唯一真相（thread-scoped）**

- 已有 PostgreSQL 持久化、多租户 `search_path` 隔离
- `ConversationID` 对应 LangGraph `thread_id`
- 不引入新存储，直接复用

**MemoryManager = 仅限长期语义记忆（cross-session，可选）**

- 保留 `longTerm`（Milvus）和 `entity` 部分
- 移除 `shortTerm` 职责（重复根源）
- 由 `ExecutionConfig.EnableMemory bool` 控制，默认 `false`

**`BaseAgent.Memory []Message` = 废弃使用**

- 保留字段以维持 `GetMemory()` 接口兼容
- 停止写入，不在 `Execute()` 中读取

### 短期/长期边界

| 层 | 实现 | 生命周期 | 范围 |
|----|------|----------|------|
| 短期（thread-scoped） | `ChatStore`（PostgreSQL） | per-ConversationID | 跨请求，同一对话 |
| 长期（cross-session） | `MemoryManager.longTerm`（Milvus） | per-UserID | 跨对话，同一用户 |

---

## 接口变更

### ExecutionConfig 新增字段

```go
// internal/agent/agent.go

type ExecutionConfig struct {
    // 已有字段不变...

    ConversationID string // 为空 = 无状态执行（向后兼容）
    UserID         string // ChatStore 权限验证所需
    HistoryWindow  int    // 加载最近 N 条消息，0 = 使用默认值 20
}
```

对应新增 option helpers：

```go
func WithConversationID(id string) ExecutionOption
func WithUserID(id string) ExecutionOption
func WithHistoryWindow(n int) ExecutionOption
```

### BaseAgent 新增字段

```go
type BaseAgent struct {
    // 已有字段不变...
    ChatStore ChatStore // nil = 降级无状态
}

func (a *BaseAgent) WithChatStore(cs ChatStore) *BaseAgent
```

---

## 新 Execute() 执行流

```
Execute(ctx, input, options...)
  ① 加载历史（短期）
      if ConversationID != "" && ChatStore != nil:
          history, err = chatStore.ListMessages(tenantID, convID, userID)
          if err: WARN + 降级无状态
          initMessages = buildInitMessages(systemPrompt, history, HistoryWindow)
      else:
          initMessages = [system_prompt, user:input]  ← 无状态，行为与现在相同

  ② 运行 graph（现有逻辑完全不变）
      finalState = cg.Invoke(ctx, ReActState{Messages: initMessages, ...})

  ③ 持久化结果（短期）
      if ConversationID != "":
          chatStore.AddMessage(tenantID, {Role:"user",  Content:input})
          chatStore.AddMessage(tenantID, {Role:"agent", Content:result.Output, StepsJSON:steps})
          if err: ERROR，不影响 result 返回

  ④ 索引语义记忆（长期，可选异步）
      if EnableMemory && MemoryManager != nil:
          go memoryManager.SemanticIndex(ctx, input, result.Output, sessionCtx)

  return result
```

步骤 ①③④ 在 `switch agentType` **外面**，所有 agent 类型自动继承。

### buildInitMessages 实现

```go
func buildInitMessages(systemPrompt string, history []*ChatMessage, window int) []capgateway.LLMMessage {
    if window <= 0 {
        window = 20
    }
    msgs := make([]capgateway.LLMMessage, 0, window+2)
    if systemPrompt != "" {
        msgs = append(msgs, capgateway.LLMMessage{Role: "system", Content: systemPrompt})
    }
    start := 0
    if len(history) > window {
        start = len(history) - window
    }
    for _, m := range history[start:] {
        role := m.Role
        if role == "agent" {
            role = "assistant" // ChatMessage.Role="agent"，LLM 协议要求 "assistant"
        }
        msgs = append(msgs, capgateway.LLMMessage{Role: role, Content: m.Content})
    }
    return msgs
}
```

---

## 数据流：HTTP → Execute()

```
POST /api/agents/:id/execute
  Body: { "input": "...", "conversation_id": "uuid", "user_id": "..." }
         ↓
  AgentHandler.ExecuteAgent()
    → WithConversationID(req.ConversationID)
    → WithUserID(req.UserID)
    → agent.Execute(ctx, req.Input, opts...)
         ↓
  BaseAgent.Execute()
    → cfg.ConversationID, cfg.UserID 解包
    → chatStore.ListMessages(tenantID, convID, userID)
    → buildInitMessages(systemPrompt, history, window)
    → graph.Invoke()
    → chatStore.AddMessage(...) × 2
```

**会话生命周期**（创建/列举/删除）由 `/api/conversations` 管理，执行接口只携带 `conversation_id`，不负责创建会话。

---

## 错误处理规则

| 场景 | 日志级别 | 行为 |
|------|----------|------|
| `ListMessages` 失败 | WARN | 降级无状态继续执行，`result` 正常返回 |
| `AddMessage`（user）失败 | ERROR | 继续保存 agent reply，`result` 正常返回 |
| `AddMessage`（agent）失败 | ERROR | `result` 正常返回，不 panic |
| `SemanticIndex` 失败 | WARN（goroutine 内） | 静默丢弃，不影响主流程 |

---

## 测试策略

### 单元测试（`react_agent_test.go` 模式）

| 用例 | ChatStore mock | 验证点 |
|------|----------------|--------|
| ConversationID 为空 | 不注入 | `ListMessages`/`AddMessage` 从未调用 |
| 有效 ConversationID，历史 2 条 | 返回 2 条 | `initMessages` = system + 2条历史 + user |
| 历史超过 HistoryWindow | 返回 25 条 | 只取最后 20 条 |
| `ListMessages` 返回 error | 注入错误 | 降级执行，`result` 有效，不 panic |
| `AddMessage` 返回 error | 注入错误 | `result` 有效，不 panic |

### 已有测试兼容性

- 所有不传 `ConversationID` 的现有测试：走无状态路径，**零改动**
- `ChatStore` 接口天然可 mock（`chatPoolIface` 模式已有先例）

---

## AddToMemory() 调整

现有 `AddToMemory()` 双写 `a.Memory` slice 和 `MemoryManager.shortTerm`，调整后：

- 写 `a.Memory` slice：**保留**（`GetMemory()` 接口兼容）
- 写 `MemoryManager.shortTerm`：**移除**
- 长期记忆索引在 `Execute()` 末尾异步触发（Step ④），不经过此方法

---

## 可扩展性保证

新增 agent 类型（CoT、Planning、ToolCalling 等）**不需要感知** ChatStore：

1. 接收已含历史的 `initMessages []capgateway.LLMMessage`
2. 填充 `result.Output`
3. BaseAgent 外层自动完成历史 load/save

与 LangGraph checkpointer 模式一致：图执行本身无感知 state persistence。

---

## 变更文件清单

| 文件 | 变更类型 | 内容 |
|------|----------|------|
| `internal/agent/agent.go` | 修改 | `ExecutionConfig` 新增3字段；`BaseAgent` 新增 `ChatStore`；`Execute()` 插入步骤①③④；新增 `buildInitMessages`；`AddToMemory()` 移除 shortTerm 写入 |
| `api/handler/agent_handler.go` | 修改 | `ExecuteAgent`/`ExecuteAgentStream` 从请求解析 `conversation_id`/`user_id`，注入为 option |
| `internal/agent/react_agent_test.go` | 修改 | 新增 5 个 ChatStore 相关表驱动用例 |
| `internal/memory/manager.go` | 修改（可选） | 标注 `shortTerm` 字段不再由 Execute() 写入；文档更新 |
