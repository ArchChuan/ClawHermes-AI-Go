# ClawHermes-AI-Go Project Rules
## Andrej Karpathy Core Four Mandatory Principles
1. Make it work: Build minimal viable core first, validate end-to-end before adding features.
2. Make it right: Fix error handling, concurrency safety, modularity after core functionality works.
3. Make it fast: Optimize NATS/Milvus performance, goroutine efficiency only after correctness is stable.
4. Make it scalable: Design plugin-oriented, MCP-compliant, multi-tenant architecture for long-term iteration.

## Layered Context Index
This file is Layer 1 (High-frequency behavioral rules).
Detailed project facts and task-specific rules are in the following standardized files:

### Layer 2 - Project Facts
(Directory structure, dependency versions, error handling, concurrency rules)
- Documentation: [`docs/agent/project.md`](docs/agent/project.md)

### Layer 3 - Task-Specific Rules
(Mandatory reading before modifying corresponding modules)
- Milvus vector database: [`docs/agent/milvus.md`](docs/agent/milvus.md)
- NATS/Hermes event bus: [`docs/agent/nats.md`](docs/agent/nats.md)
- API endpoints & Gateway: [`docs/agent/api.md`](docs/agent/api.md)
- Agent core system: [`docs/agent/agent.md`](docs/agent/agent.md)
- Observability & monitoring: [`docs/agent/observability.md`](docs/agent/observability.md)

## Go & Agent Engineering Standards
- Follow Go idiomatic style, goroutine-safe, no memory leak.
- Single-responsibility modules, clean dependency boundaries.
- Use Zap structured logging only; no fmt print.
- Milvus logic only in pkg/milvus; NATS only in pkg/nats.
- Strict MCP & Skill-Plugin extensibility for agent workflow.

## Output Constraints (Critical for Token Save)
- ONLY output runnable code, config or schema.
- NO verbose explanation, NO redundant text, NO off-topic content.
- Surgical changes only: edit required scope, no unrelated refactoring.

## Validation & Safety
- Run `go vet` and `go test -short` after every change.
- Do NOT modify config/prod.yaml, internal/auth/* without explicit approval.
- No destructive operations without confirmation.