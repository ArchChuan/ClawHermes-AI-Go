# Project Facts Reference

## Directory Structure

```
cmd/server/main.go          - Single entry point, initializes Harness and registers components
api/
  router.go                 - Route registration (Gin), all endpoints defined here
  handler/                  - One handler file per domain
  middleware/               - CORS, Trace, Prometheus, Recovery
  model/                    - Request/Response DTOs, no business logic
internal/
  config/                   - Viper config loading, InitializeServices connects external deps
  harness/                  - App lifecycle: Component register → sequential start → reverse stop
  hermes/                   - NATS client wrapper, Publish/Subscribe
  agent/                    - Agent framework (BaseAgent, Registry, Manager)
  agent/a2a/                - A2A protocol (Discovery, Negotiation, Orchestrator)
  memory/                   - Three-tier memory: short-term(Buffer/Window/Summary), long-term(Vector), entity(Entity)
  skill/                    - Skill definition and Executor
  orchestrator/             - Skill registry and orchestration
  knowledge/                - GraphRAG (Neo4j + Milvus)
  llmgateway/               - LLM gateway, MCP protocol
  textchunk/                - Text chunking
pkg/
  mcp/                      - MCP type definitions + VectorStore (Milvus SDK v2.4.2)
  observability/            - Logger(Zap), Tracer(OTEL), Metrics(Prometheus)
web/                        - Vue 3 + Vite frontend
k8s/                        - Kubernetes manifests
charts/                     - Helm chart
```

## Dependency Versions & SDK Usage

| Dependency | Version | Key Notes |
|-----------|---------|-----------|
| Go | 1.22+ | Generics, slog compatible |
| Gin | v1.9+ | Route groups via `r.Group`, middleware registered in router.go |
| NATS | v1.31+ | JetStream mode, subject format `domain.action` |
| Milvus SDK | v2.4.2 | `client.Search` param order: see `pkg/mcp/vector_store.go` |
| Neo4j Driver | v5.x | `session.Run` returns `(Result, error)`, use `result.Collect(ctx)` |
| Zap | v1.26+ | Production: `NewProduction()`, Dev: `NewDevelopment()` |
| OTEL | v1.21+ | TracerProvider init in main, propagated via context |
| Viper | v1.18+ | Supports `.env` + env vars, priority: env > file > default |

## Error Handling Patterns

1. **API layer**: Uniform `model.ErrorResponse`, semantically correct HTTP status codes
2. **internal layer**: Return `error`, never swallow errors, never panic (except MustGet methods)
3. **External connections**: `config.InitializeServices` warns on failure but does not block startup
4. **Context**: All cross-component calls pass `context.Context`, supporting timeout and cancellation

## Concurrency Safety Rules

- Registry/Manager types use `sync.RWMutex` (read-heavy)
- Single Agent execution uses `sync.Mutex`
- Channels for goroutine communication, not shared memory

## Testing Conventions

- Unit test files `*_test.go` co-located with source
- Integration tests require Docker services, tagged `//go:build integration`
- Run: `make test` (unit), `make test-integration` (integration)

## Build & Deploy

- Binary output: `bin/clawhermes`
- Docker image: `Dockerfile` multi-stage build
- Local dev: `./start.sh` (starts docker-compose + app)
- K8s deploy: `helm install` using `charts/clawhermes-ai/`
