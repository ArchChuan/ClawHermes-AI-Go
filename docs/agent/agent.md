# Agent Development Rules

## Agent Types

| Type | Constant | Use Case |
|------|----------|----------|
| ReAct | `agent.ReActAgent` | Observe-reason-act loop |
| CoT | `agent.CoTAgent` | Multi-step reasoning |
| Planning | `agent.PlanningAgent` | Task decomposition & planning |
| Tool Calling | `agent.ToolCallingAgent` | Structured tool invocation |
| RAG | `agent.RAGAgent` | Retrieval-augmented generation |
| Swarm | `agent.SwarmAgent` | Multi-agent collaboration |

## Creating an Agent

```go
config := &agent.AgentConfig{
    ID:            "unique-id",
    Name:          "Display Name",
    Type:          agent.ReActAgent,
    Description:   "Description",
    SystemPrompt:  "System prompt",
    MaxIterations: 5,
}
a := agent.NewBaseAgent(config, logger)
registry.Register(a)
```

## Execution Options

```go
result, err := registry.Execute(ctx, agentID, query,
    agent.WithMaxSteps(10),
    agent.WithMemory(true),
    agent.WithTemperature(0.7),
)
```

## Memory Integration

Agent injects memory manager via `SetMemoryManager`:

```go
agent.SetMemoryManager(memoryManager)
// Automatically retrieves relevant memory during execution
// Results automatically written to memory
```

## A2A Protocol

Multi-agent collaboration implemented in `internal/agent/a2a/`:

- Create Protocol → Create Client → Announce capabilities → Discover/Negotiate/Collaborate
- 8 collaboration strategies selected via `Orchestrator`
- Messages processed asynchronously through Inbox/Outbox

## Rules

1. Agent ID must be globally unique; registering a duplicate ID overwrites the existing one
2. `Execute` holds a lock internally; concurrent execution on the same Agent is not supported
3. `MaxIterations` prevents infinite loops, default 10
4. Agent's `Reset()` clears memory and state — use with caution
