//go:build integration

package migration_test

import (
	"os"
	"testing"

	"github.com/byteBuilderX/ClawHermes-AI-Go/internal/migration"
	"go.uber.org/zap"
)

func TestRunPublicSchema(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		url = "pgx5://clawhermes:clawhermes@localhost:5432/clawhermes"
	}

	logger := zap.NewNop()
	// sql dir is relative to project root when tests run from repo root
	if err := migration.RunPublicSchema(url, "sql", logger); err != nil {
		t.Fatalf("RunPublicSchema() error = %v", err)
	}
}
