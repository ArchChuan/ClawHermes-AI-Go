package constants

import "time"

const (
	// HTTP server
	HTTPReadHeaderTimeout = 10 * time.Second
	HTTPShutdownTimeout   = 10 * time.Second

	// Agent execution
	AgentExecTimeout = 120 * time.Second

	// LLM per-request
	LLMRequestTimeout = 60 * time.Second

	// Router health-check probe
	RouterHealthTimeout = 3 * time.Second

	// MCP client connection idle
	MCPIdleTimeout = 5 * time.Minute

	// Gateway cache entry TTL
	GatewayCacheTTL = 5 * time.Minute
)
