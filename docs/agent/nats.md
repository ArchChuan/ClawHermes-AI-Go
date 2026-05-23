# NATS / Hermes Development Rules

## Connection Config

- URL format: `nats://host:4222`
- JetStream mode enabled by default
- Reconnection: SDK built-in auto-reconnect, no manual implementation needed

## Subject Naming Convention

```
{domain}.{action}[.{qualifier}]
```

Examples:
- `skill.executed` - Skill execution completed
- `agent.started` - Agent started
- `memory.persisted` - Memory persisted
- `knowledge.ingested` - Knowledge ingestion completed

## Event Structure

```go
type Event struct {
    ID        string
    Type      string    // Subject name
    Timestamp time.Time
    Source    string    // Sender component name
    Data      interface{}
}
```

## Usage Patterns

### Publish Event

```go
client.Publish(hermes.Event{
    Type:   "skill.executed",
    Source: "skill-executor",
    Data:   result,
})
```

### Subscribe to Events

```go
client.Subscribe("memory.*", func(event hermes.Event) {
    // handle event
})
```

## Rules

1. **Never block in handlers**: Event processing should return quickly; spawn goroutine for heavy work
2. **Idempotency**: Messages may be delivered more than once; handlers must be idempotent
3. **Error handling**: Subscribe handlers catch panics internally, log but don't interrupt
4. **Connection failure**: NATS connection failure in `InitializeServices` only warns, does not block startup
