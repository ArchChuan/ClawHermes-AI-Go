# Observability Development Rules

## Tracing (OpenTelemetry)

### Initialization

TracerProvider is initialized in `cmd/server/main.go`, propagated via context.

```go
cfg := &observability.TraceConfig{
    ServiceName:  "clawhermes-ai",
    ExporterType: "otlp",          // otlp | jaeger | stdout
    OTLPEndpoint: "localhost:4317",
}
tp, err := observability.InitTracer(cfg, logger)
defer tp.Shutdown(ctx)
```

### Creating Spans

```go
tracer := observability.NewTracer(logger)
ctx, span := tracer.StartSpan(ctx, "operation-name")
defer span.End()

// Add attributes
span.SetAttributes(attribute.String("key", "value"))
// Record error
span.RecordError(err)
span.SetStatus(codes.Error, err.Error())
```

### Rules

- Each handler method automatically gets a Span via `middleware/trace.go`
- Key operations in internal layer create child Spans manually
- Span name format: `{component}.{operation}`, e.g. `agent.execute`, `memory.search`

## Metrics (Prometheus)

### Built-in Metrics

```
http_requests_total{method, path, status}
http_request_duration_seconds{method, path}
skill_executions_total{skill_id, status}
agent_executions_total{agent_id, type, status}
llm_requests_total{model, status}
knowledge_queries_total{type, status}
hermes_events_total{type, status}
```

### Adding New Metrics

Add in `pkg/observability/prometheus.go`, follow naming conventions:
- Counter: `{domain}_{action}_total`
- Histogram: `{domain}_{action}_seconds`
- Gauge: `{domain}_{state}`

## Logging (Zap)

### Usage Standards

```go
logger.Info("operation completed", zap.String("id", id), zap.Duration("elapsed", d))
logger.Error("operation failed", zap.Error(err), zap.String("context", ctx))
```

### Rules

- Never use `fmt.Sprintf` for log messages; use structured fields
- Error level: requires human intervention
- Warn level: auto-recoverable but needs attention
- Info level: key business events
- Debug level: development debugging info

## Local Access

- Jaeger UI: http://localhost:16686
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (admin/admin)
