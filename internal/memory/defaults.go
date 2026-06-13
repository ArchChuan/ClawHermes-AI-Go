package memory

import "time"

const (
	DefaultWindowSize      = 10
	DefaultMaxMessages     = 100
	DefaultPersistInterval = 5 * time.Minute
	DefaultMaxMemoryAge    = 30 * 24 * time.Hour
	DefaultSearchLimit     = 20
)
