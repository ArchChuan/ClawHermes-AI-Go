package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

const (
	defaultMaxConns = 20
	defaultMinConns = 2
)

type Pool struct {
	pool   *pgxpool.Pool
	logger *zap.Logger
}

func New(ctx context.Context, url string, logger *zap.Logger) (*Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("postgres: parse config: %w", err)
	}
	cfg.MaxConns = defaultMaxConns
	cfg.MinConns = defaultMinConns

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("postgres: connect: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres: ping: %w", err)
	}

	logger.Info("postgres connected", zap.String("url", maskPassword(url)))
	return &Pool{pool: pool, logger: logger}, nil
}

func (p *Pool) DB() *pgxpool.Pool { return p.pool }

func (p *Pool) Close() {
	p.pool.Close()
	p.logger.Info("postgres connection closed")
}

func maskPassword(url string) string {
	return "postgres://***@" + extractHost(url)
}

func extractHost(url string) string {
	for i := len(url) - 1; i >= 0; i-- {
		if url[i] == '@' {
			return url[i+1:]
		}
	}
	return url
}
