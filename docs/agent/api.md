# API Development Rules

## Route Registration

All routes are registered centrally in `api/router.go`, never scattered across handler files.

```go
// Route organization
v1 := r.Group("/api/v1")  // For future versioning
skills := r.Group("/skills")
agents := r.Group("/agents")
```

## Handler Writing Standards

### File Naming

One file per domain: `handler/skill_handler.go`, `handler/agent_handler.go`

### Struct Pattern

```go
type SkillHandler struct {
    registry *orchestrator.Registry
    logger   *zap.Logger
}

func NewSkillHandler(registry *orchestrator.Registry, logger *zap.Logger) *SkillHandler {
    return &SkillHandler{registry: registry, logger: logger}
}
```

### Request/Response

- Request bodies defined in `api/model/` directory
- Bind with `c.ShouldBindJSON(&req)`, return 400 on failure
- Success: `c.JSON(http.StatusOK, data)`
- Error: `c.JSON(statusCode, model.ErrorResponse{...})`

### HTTP Status Code Conventions

| HTTP Status | Scenario |
|-------------|----------|
| 400 | Invalid request parameters |
| 404 | Resource not found |
| 409 | Resource conflict (duplicate creation) |
| 500 | Internal error |

## Middleware

- `middleware/cors.go` - CORS configuration
- `middleware/trace.go` - OpenTelemetry Span injection
- `middleware/prometheus.go` - Request metrics collection
- `middleware/recovery.go` - Panic recovery

Registration order: Recovery → CORS → Trace → Prometheus → Routes

## New Endpoint Checklist

1. Define request/response structs in `api/model/`
2. Implement handler method in `handler/`
3. Register route in `router.go`
4. Confirm middleware coverage (Trace, Metrics)
5. Run `go build ./...` to verify compilation
