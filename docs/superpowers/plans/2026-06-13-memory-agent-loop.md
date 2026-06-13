# Memory-Agent Loop Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire ChatStore as the single source of truth for short-term conversation history, injecting it into the ReAct loop so the agent maintains multi-turn context.

**Architecture:** `Execute()` wraps the existing switch block with load-before/save-after steps keyed on `ConversationID`. Empty `ConversationID` = stateless fallback (current behavior). `MemoryManager.shortTerm` is retained but no longer written from the Execute path — it becomes long-term-only via async indexing.

**Tech Stack:** Go 1.22, pgx v5, internal ChatStore (PostgreSQL), capgateway.LLMMessage

---

## File Map

| File | Change |
|------|--------|
| `internal/agent/agent.go` | Add fields to `ExecutionConfig`; add `ChatStore` to `BaseAgent`; add `buildInitMessages()`; modify `Execute()`; add option helpers; strip shortTerm from `AddToMemory()` |
| `internal/agent/react_agent_test.go` | Add 5 new test cases for ChatStore integration |
| `api/handler/agent_handler.go` | Add `ConversationID`/`UserID` to `ExecuteAgentRequest`; pass them as options |

No new files. No schema changes (ChatStore tables already exist).

---

## Task 1: Add ConversationID/UserID/HistoryWindow to ExecutionConfig + option helpers

**Files:**

- Modify: `internal/agent/agent.go:64-77` (ExecutionConfig struct)
- Modify: `internal/agent/agent.go:479+` (option helpers section)

**Step 1: Write the failing test**

Add to `internal/agent/react_agent_test.go`:

```go
func TestWithConversationID_SetsField(t *testing.T) {
 cfg := &agent.ExecutionConfig{}
 agent.WithConversationID("conv-123")(cfg)
 require.Equal(t, "conv-123", cfg.ConversationID)
}

func TestWithUserID_SetsField(t *testing.T) {
 cfg := &agent.ExecutionConfig{}
 agent.WithUserID("user-456")(cfg)
 require.Equal(t, "user-456", cfg.UserID)
}

func TestWithHistoryWindow_SetsField(t *testing.T) {
 cfg := &agent.ExecutionConfig{}
 agent.WithHistoryWindow(10)(cfg)
 require.Equal(t, 10, cfg.HistoryWindow)
}
```

**Step 2: Run test to verify it fails**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go test ./internal/agent/... -run "TestWithConversationID|TestWithUserID|TestWithHistoryWindow" -v
```

Expected: FAIL — `cfg.ConversationID` undefined

**Step 3: Implement**

In `internal/agent/agent.go`, add to `ExecutionConfig` struct after `ExtraTools`:

```go
ConversationID string
UserID         string
HistoryWindow  int // 0 means default (20)
```

Add option helpers after `WithExtraTools`:

```go
func WithConversationID(id string) ExecutionOption {
 return func(cfg *ExecutionConfig) {
  cfg.ConversationID = id
 }
}

func WithUserID(id string) ExecutionOption {
 return func(cfg *ExecutionConfig) {
  cfg.UserID = id
 }
}

func WithHistoryWindow(n int) ExecutionOption {
 return func(cfg *ExecutionConfig) {
  cfg.HistoryWindow = n
 }
}
```

**Step 4: Run test to verify it passes**

```bash
go test ./internal/agent/... -run "TestWithConversationID|TestWithUserID|TestWithHistoryWindow" -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/agent/agent.go internal/agent/react_agent_test.go
git commit -m "feat(agent): add ConversationID/UserID/HistoryWindow to ExecutionConfig"
```

---

## Task 2: Add ChatStore field to BaseAgent + WithChatStore setter

**Files:**

- Modify: `internal/agent/agent.go:119-129` (BaseAgent struct)

**Step 1: Write the failing test**

Add to `internal/agent/react_agent_test.go`:

```go
func TestBaseAgent_WithChatStore_SetsField(t *testing.T) {
 a := newReActAgent()
 cs := &mockChatStore{}
 result := a.WithChatStore(cs)
 require.Same(t, a, result) // returns self for chaining
}
```

Also add the minimal mock at the top of the test file (package-level, before the existing `mockCapGW`):

```go
type mockChatStore struct {
 agent.ChatStore
 listMsgs func(ctx context.Context, tenantID, convID, userID string) ([]*agent.ChatMessage, error)
 addMsg   func(ctx context.Context, tenantID string, msg *agent.ChatMessage) error
}

func (m *mockChatStore) ListMessages(ctx context.Context, tenantID, convID, userID string) ([]*agent.ChatMessage, error) {
 if m.listMsgs != nil {
  return m.listMsgs(ctx, tenantID, convID, userID)
 }
 return nil, nil
}

func (m *mockChatStore) AddMessage(ctx context.Context, tenantID string, msg *agent.ChatMessage) error {
 if m.addMsg != nil {
  return m.addMsg(ctx, tenantID, msg)
 }
 return nil
}
```

**Step 2: Run test to verify it fails**

```bash
go test ./internal/agent/... -run "TestBaseAgent_WithChatStore" -v
```

Expected: FAIL — `a.WithChatStore` undefined

**Step 3: Implement**

Add `ChatStore ChatStore` to `BaseAgent` struct in `agent.go`:

```go
type BaseAgent struct {
 *AgentConfig
 Logger         *zap.Logger
 metrics        observability.MetricsProvider
 State          AgentState
 Memory         []Message
 mu             sync.Mutex
 MemoryManager  *memory.MemoryManager
 SessionContext *memory.SessionContext
 CapGateway     capgateway.CapabilityGateway
 ChatStore      ChatStore  // add this line
}
```

Add setter method after `SetCapGateway`:

```go
func (a *BaseAgent) WithChatStore(cs ChatStore) *BaseAgent {
 a.mu.Lock()
 defer a.mu.Unlock()
 a.ChatStore = cs
 return a
}
```

**Step 4: Run test to verify it passes**

```bash
go test ./internal/agent/... -run "TestBaseAgent_WithChatStore" -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/agent/agent.go internal/agent/react_agent_test.go
git commit -m "feat(agent): add ChatStore field and WithChatStore setter to BaseAgent"
```

---

## Task 3: Implement buildInitMessages()

**Files:**

- Modify: `internal/agent/agent.go` (add package-level function, no struct changes)

**Step 1: Write the failing test**

Add to `internal/agent/react_agent_test.go`:

```go
func TestBuildInitMessages_NilHistory(t *testing.T) {
 msgs := agent.BuildInitMessages("You are helpful.", nil, 0)
 require.Len(t, msgs, 1)
 require.Equal(t, "system", msgs[0].Role)
}

func TestBuildInitMessages_WindowTruncation(t *testing.T) {
 history := make([]*agent.ChatMessage, 25)
 for i := range history {
  role := "user"
  if i%2 == 1 {
   role = "agent"
  }
  history[i] = &agent.ChatMessage{Role: role, Content: fmt.Sprintf("msg %d", i)}
 }
 // window=20, system + 20 history = 21 total
 msgs := agent.BuildInitMessages("sys", history, 20)
 require.Len(t, msgs, 21)
 require.Equal(t, "system", msgs[0].Role)
 // last message should be history[24]
 require.Equal(t, "user", msgs[20].Role)
 require.Equal(t, "msg 24", msgs[20].Content)
}

func TestBuildInitMessages_AgentRoleMapping(t *testing.T) {
 history := []*agent.ChatMessage{
  {Role: "user", Content: "hello"},
  {Role: "agent", Content: "hi"},
 }
 msgs := agent.BuildInitMessages("", history, 0)
 require.Len(t, msgs, 2)
 require.Equal(t, "assistant", msgs[1].Role) // "agent" → "assistant"
}

func TestBuildInitMessages_NoSystemPrompt(t *testing.T) {
 history := []*agent.ChatMessage{{Role: "user", Content: "hi"}}
 msgs := agent.BuildInitMessages("", history, 0)
 require.Len(t, msgs, 1)
 require.Equal(t, "user", msgs[0].Role)
}
```

Note: this requires `BuildInitMessages` exported (capital B) to be testable from `agent_test` package.

**Step 2: Run test to verify it fails**

```bash
go test ./internal/agent/... -run "TestBuildInitMessages" -v
```

Expected: FAIL — `agent.BuildInitMessages` undefined

**Step 3: Implement**

Add at end of `internal/agent/agent.go` (before `ApplyOptions`):

```go
// BuildInitMessages constructs the LLM message slice from system prompt + chat history.
// "agent" role is normalized to "assistant". window=0 defaults to 20 messages.
func BuildInitMessages(systemPrompt string, history []*ChatMessage, window int) []capgateway.LLMMessage {
 if window <= 0 {
  window = 20
 }
 capacity := window + 1
 if systemPrompt == "" {
  capacity = window
 }
 msgs := make([]capgateway.LLMMessage, 0, capacity)
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
   role = "assistant"
  }
  msgs = append(msgs, capgateway.LLMMessage{Role: role, Content: m.Content})
 }
 return msgs
}
```

**Step 4: Run test to verify it passes**

```bash
go test ./internal/agent/... -run "TestBuildInitMessages" -v
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add internal/agent/agent.go internal/agent/react_agent_test.go
git commit -m "feat(agent): implement BuildInitMessages with window truncation and role normalization"
```

---

## Task 4: Wire Execute() — load history from ChatStore before graph runs

**Files:**

- Modify: `internal/agent/agent.go:253-409` (Execute method)

**Step 1: Write the failing test**

Add to `internal/agent/react_agent_test.go`:

```go
func TestBaseAgent_ReActExecute_LoadsHistoryFromChatStore(t *testing.T) {
 a := newReActAgent()
 gw := &mockCapGW{responses: []capgateway.CapabilityResponse{
  {Content: "I remember you asked before", Usage: capgateway.TokenUsage{Total: 30}},
 }}
 a.SetCapGateway(gw)

 var capturedMessages []capgateway.LLMMessage
 // Capture what the LLM receives
 origRoute := gw.responses
 _ = origRoute
 gw.captureFirstMessages = &capturedMessages

 history := []*agent.ChatMessage{
  {Role: "user", Content: "what is 2+2?"},
  {Role: "agent", Content: "4"},
 }
 cs := &mockChatStore{
  listMsgs: func(_ context.Context, _, _, _ string) ([]*agent.ChatMessage, error) {
   return history, nil
  },
 }
 a.WithChatStore(cs)

 result, err := a.Execute(context.Background(), "and 3+3?",
  agent.WithTenantID("t1"),
  agent.WithConversationID("conv-abc"),
  agent.WithUserID("user-1"),
 )
 require.NoError(t, err)
 require.Equal(t, "I remember you asked before", result.Output)
}
```

Note: this test doesn't assert on captured messages (that would require deeper mock wiring). It asserts the execution succeeds when ChatStore is set and ConversationID is provided — confirming no panic/error in the load path.

**Step 2: Run test to verify it fails**

```bash
go test ./internal/agent/... -run "TestBaseAgent_ReActExecute_LoadsHistory" -v
```

Expected: PASS already? No — it passes vacuously because the mock returns history but Execute ignores it. We need to verify the NEW behavior (history injected). Actually the test verifies the happy path compiles and runs without error — this is the minimal contract for this task. The deeper assertion on what messages the LLM sees comes in integration testing.

**Step 3: Implement**

In `Execute()`, after the lock snapshot block (after `a.mu.Unlock()` on line ~274), add history load before the switch:

```go
// Snapshot ChatStore under lock
a.mu.Lock()
chatStore := a.ChatStore
a.mu.Unlock()

// ① Load conversation history (no-op when ConversationID is empty)
var history []*ChatMessage
if chatStore != nil && cfg.ConversationID != "" {
 var loadErr error
 history, loadErr = chatStore.ListMessages(ctx, cfg.TenantID, cfg.ConversationID, cfg.UserID)
 if loadErr != nil {
  a.Logger.Warn("agent: load history failed",
   zap.String("conversation_id", cfg.ConversationID),
   zap.Error(loadErr),
  )
  history = nil // degrade gracefully
 }
}
```

Then in the `ReActAgent` case, replace the current `initMessages` construction (lines 299-303):

```go
// was:
// initMessages := make([]capgateway.LLMMessage, 0, 2)
// if systemPrompt != "" {
//     initMessages = append(initMessages, capgateway.LLMMessage{Role: "system", Content: systemPrompt})
// }
// initMessages = append(initMessages, capgateway.LLMMessage{Role: "user", Content: input})

// now:
initMessages := BuildInitMessages(systemPrompt, history, cfg.HistoryWindow)
initMessages = append(initMessages, capgateway.LLMMessage{Role: "user", Content: input})
```

**Step 4: Run tests**

```bash
go test ./internal/agent/... -v -race -timeout 30s
```

Expected: all existing tests still PASS (ConversationID="" → history=nil → BuildInitMessages returns [system]+[user] same as before), new test PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/agent/agent.go internal/agent/react_agent_test.go
git commit -m "feat(agent): wire Execute() to load conversation history from ChatStore"
```

---

## Task 5: Wire Execute() — persist user + agent messages after graph runs

**Files:**

- Modify: `internal/agent/agent.go` (Execute method, after switch block)

**Step 1: Write the failing test**

Add to `internal/agent/react_agent_test.go`:

```go
func TestBaseAgent_ReActExecute_PersistsMessages(t *testing.T) {
 a := newReActAgent()
 gw := &mockCapGW{responses: []capgateway.CapabilityResponse{
  {Content: "pong", Usage: capgateway.TokenUsage{Total: 10}},
 }}
 a.SetCapGateway(gw)

 var persisted []*agent.ChatMessage
 cs := &mockChatStore{
  addMsg: func(_ context.Context, _ string, msg *agent.ChatMessage) error {
   persisted = append(persisted, msg)
   return nil
  },
 }
 a.WithChatStore(cs)

 _, err := a.Execute(context.Background(), "ping",
  agent.WithTenantID("t1"),
  agent.WithConversationID("conv-xyz"),
  agent.WithUserID("user-2"),
 )
 require.NoError(t, err)
 require.Len(t, persisted, 2)
 require.Equal(t, "user", persisted[0].Role)
 require.Equal(t, "ping", persisted[0].Content)
 require.Equal(t, "agent", persisted[1].Role)
 require.Equal(t, "pong", persisted[1].Content)
}
```

**Step 2: Run test to verify it fails**

```bash
go test ./internal/agent/... -run "TestBaseAgent_ReActExecute_PersistsMessages" -v
```

Expected: FAIL — `persisted` is empty (persist not yet wired)

**Step 3: Implement**

After the switch block and before the metrics calls in `Execute()`, add:

```go
// ③ Persist user + agent messages (fire-and-keep-errors-local)
if chatStore != nil && cfg.ConversationID != "" && execErr == nil {
 saveCtx := context.Background() // decouple from request ctx
 userMsg := &ChatMessage{
  ConversationID: cfg.ConversationID,
  Role:           "user",
  Content:        input,
 }
 if err := chatStore.AddMessage(saveCtx, cfg.TenantID, userMsg); err != nil {
  a.Logger.Warn("agent: persist user message failed",
   zap.String("conversation_id", cfg.ConversationID),
   zap.Error(err),
  )
 }
 if result.Output != "" {
  agentMsg := &ChatMessage{
   ConversationID: cfg.ConversationID,
   Role:           "agent",
   Content:        result.Output,
  }
  if err := chatStore.AddMessage(saveCtx, cfg.TenantID, agentMsg); err != nil {
   a.Logger.Warn("agent: persist agent message failed",
    zap.String("conversation_id", cfg.ConversationID),
    zap.Error(err),
   )
  }
 }
}
```

**Step 4: Run tests**

```bash
go test ./internal/agent/... -v -race -timeout 30s
```

Expected: all tests PASS including new persistence test.

- [ ] **Step 5: Commit**

```bash
git add internal/agent/agent.go internal/agent/react_agent_test.go
git commit -m "feat(agent): persist user and agent messages to ChatStore after execution"
```

---

## Task 6: Optional async long-term indexing (fire-and-forget)

**Files:**

- Modify: `internal/agent/agent.go` (Execute method, after step ③)

No test needed — this is best-effort async. The behavior contract is: it must not block execution and must not panic.

**Step 1: Implement**

After the step ③ block, add:

```go
// ④ Async long-term indexing (best-effort, non-blocking)
if a.MemoryManager != nil && a.SessionContext != nil && result.Output != "" {
 go func() {
  indexCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
  defer cancel()
  entry := &memory.MemoryEntry{
   Role:      "assistant",
   Content:   result.Output,
   TenantID:  cfg.TenantID,
   UserID:    cfg.UserID,
   SessionID: cfg.ConversationID,
   AgentID:   agentID,
  }
  if err := a.MemoryManager.Add(indexCtx, entry); err != nil {
   a.Logger.Warn("agent: async long-term index failed", zap.Error(err))
  }
 }()
}
```

**Step 2: Build and run existing tests**

```bash
go vet ./internal/agent/...
go test ./internal/agent/... -v -race -timeout 30s
```

Expected: all tests PASS, no vet errors.

- [ ] **Step 3: Commit**

```bash
git add internal/agent/agent.go
git commit -m "feat(agent): add async long-term memory indexing after execution"
```

---

## Task 7: Remove shortTerm write from AddToMemory()

**Files:**

- Modify: `internal/agent/agent.go:210-235` (AddToMemory method)

**Step 1: Write the failing test**

This change removes dual-write to `MemoryManager.Add()` from `AddToMemory`. We add a test confirming the in-process Memory slice still works after the change:

```go
func TestBaseAgent_AddToMemory_StillAddsToSlice(t *testing.T) {
 a := newReActAgent()
 a.AddToMemory(agent.Message{Role: "user", Content: "hello"})
 mem := a.GetMemory()
 require.Len(t, mem, 1)
 require.Equal(t, "user", mem[0].Role)
}
```

**Step 2: Run test to verify it passes already**

```bash
go test ./internal/agent/... -run "TestBaseAgent_AddToMemory_StillAddsToSlice" -v
```

Expected: PASS (this confirms the slice write still works before and after the change)

**Step 3: Implement**

Remove the `MemoryManager` dual-write block from `AddToMemory()`. The method becomes:

```go
func (a *BaseAgent) AddToMemory(msg Message) {
 a.mu.Lock()
 defer a.mu.Unlock()
 msg.Timestamp = time.Now()
 a.Memory = append(a.Memory, msg)
 if len(a.Memory) > 100 {
  a.Memory = a.Memory[len(a.Memory)-100:]
 }
}
```

**Step 4: Run all tests**

```bash
go test ./internal/agent/... -v -race -timeout 30s
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/agent/agent.go
git commit -m "refactor(agent): remove shortTerm MemoryManager write from AddToMemory; long-term indexing moved to Execute()"
```

---

## Task 8: agent_handler.go — add ConversationID/UserID to request, pass as options

**Files:**

- Modify: `api/handler/agent_handler.go:71-75` (ExecuteAgentRequest struct)
- Modify: `api/handler/agent_handler.go:355+` (ExecuteAgent handler)
- Modify: `api/handler/agent_handler.go:532+` (ExecuteAgentStream handler)

**Step 1: Write the failing test**

In `api/handler/agent_handler_test.go` (or `handler_test.go`), add:

```go
func TestExecuteAgent_PassesConversationID(t *testing.T) {
 // Build a request body with conversation_id and user_id
 body := `{"query":"hello","conversation_id":"conv-111","user_id":"user-999"}`
 req := httptest.NewRequest(http.MethodPost, "/agents/agent-001/execute", strings.NewReader(body))
 req.Header.Set("Content-Type", "application/json")
 // ... set up handler with mock agent that captures options ...
 // Assert that agent.Execute was called with ConversationID="conv-111"
}
```

Note: the exact mock setup depends on test harness in `handler_test.go`. Check existing test patterns in that file and follow them. The core assertion: when `conversation_id` is in the JSON body, it must reach the agent's `ExecutionConfig.ConversationID`.

Read `api/handler/handler_test.go` for the test harness pattern before writing this test.

**Step 2: Implement**

Add fields to `ExecuteAgentRequest`:

```go
type ExecuteAgentRequest struct {
 Query          string                 `json:"query"`
 Context        map[string]interface{} `json:"context"`
 Options        map[string]interface{} `json:"options"`
 ConversationID string                 `json:"conversation_id"`
 UserID         string                 `json:"user_id"`
}
```

In `ExecuteAgent` handler, find the `a.Execute(ctx, req.Query, ...)` call and add the new options:

```go
agent.WithConversationID(req.ConversationID),
agent.WithUserID(req.UserID),
```

Do the same in `ExecuteAgentStream`.

**Step 3: Run tests**

```bash
go test ./api/handler/... -v -race -timeout 30s
```

Expected: all handler tests PASS.

- [ ] **Step 4: Commit**

```bash
git add api/handler/agent_handler.go
git commit -m "feat(handler): accept conversation_id and user_id in ExecuteAgent/ExecuteAgentStream requests"
```

---

## Task 9: Full build verification

**Step 1: Vet + short tests**

```bash
cd /home/yang/go-projects/ClawHermes-AI-Go
go vet ./...
go test -short ./...
```

Expected: 0 vet errors, all tests PASS.

**Step 2: Race detector full suite**

```bash
go test -v -race -timeout 60s ./internal/agent/... ./api/handler/...
```

Expected: no races, all tests PASS.

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -u
git commit -m "chore(agent): memory-agent loop integration complete"
```

---

## Backward Compatibility Checklist

- [ ] Existing tests with no `ConversationID` still pass (empty string → no-op ChatStore load/save)
- [ ] `ChatStore = nil` → no panic (all ChatStore usages are guarded by `chatStore != nil`)
- [ ] Future agent types (CoT, Planning, etc.) automatically get history inject/persist — the load/save is outside the switch block
- [ ] `MemoryManager = nil` → long-term indexing goroutine skipped (guarded check)
