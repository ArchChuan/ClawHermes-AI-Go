// Package auth provides JWT token management and authentication.
package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CreateTenantInput holds the fields needed to create a new tenant.
type CreateTenantInput struct {
	GitHubID    int64
	GitHubLogin string
	AvatarURL   string
	Name        string
	GitHubOrg   string
}

// CreateTenantResult is returned on successful tenant creation.
type CreateTenantResult struct {
	TenantID   string
	SchemaName string
	UserUUID   string
}

// JoinTenantInput holds the fields needed to join an existing tenant via invitation.
type JoinTenantInput struct {
	UserID          string
	InvitationToken string
}

// OnboardService handles tenant creation and joining logic.
type OnboardService struct {
	db *pgxpool.Pool
}

// NewOnboardService creates an OnboardService.
func NewOnboardService(db *pgxpool.Pool) *OnboardService {
	return &OnboardService{db: db}
}

// CreateTenant runs a transaction that:
//  1. Upserts the GitHub user into `users`, returning their UUID
//  2. Inserts a new row in `tenants`
//  3. Inserts the creator as `admin` in `tenant_members`
//  4. Executes `CREATE SCHEMA tenant_{id}`
func (s *OnboardService) CreateTenant(ctx context.Context, in CreateTenantInput) (*CreateTenantResult, error) {
	tenantID := uuid.New().String()
	schemaName := "tenant_" + tenantID

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("onboard: begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// upsert user, get UUID
	var userUUID string
	err = tx.QueryRow(ctx,
		`INSERT INTO users (github_id, github_login, avatar_url)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (github_id) DO UPDATE
		   SET github_login = EXCLUDED.github_login,
		       avatar_url   = EXCLUDED.avatar_url,
		       last_login_at = now()
		 RETURNING id`,
		fmt.Sprintf("%d", in.GitHubID), in.GitHubLogin, in.AvatarURL,
	).Scan(&userUUID)
	if err != nil {
		return nil, fmt.Errorf("onboard: upsert user: %w", err)
	}

	slug := in.GitHubOrg
	if slug == "" {
		slug = tenantID[:8]
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenants (id, name, slug, github_org_name) VALUES ($1, $2, $3, $4)`,
		tenantID, in.Name, slug, in.GitHubOrg,
	)
	if err != nil {
		return nil, fmt.Errorf("onboard: insert tenant: %w", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`,
		tenantID, userUUID,
	)
	if err != nil {
		return nil, fmt.Errorf("onboard: insert tenant_member: %w", err)
	}

	// schema name is safe: uses UUID chars (hex + hyphens) only
	_, err = tx.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA IF NOT EXISTS "%s"`, schemaName))
	if err != nil {
		return nil, fmt.Errorf("onboard: create schema: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("onboard: commit: %w", err)
	}

	return &CreateTenantResult{TenantID: tenantID, SchemaName: schemaName, UserUUID: userUUID}, nil
}

// GetUserTenant looks up an existing user by GitHub ID and returns their UUID and
// first active tenant. Returns found=false if the user does not exist or has no
// tenant membership.
func (s *OnboardService) GetUserTenant(ctx context.Context, githubID string) (userID, tenantID string, found bool, err error) {
	var uid, tid string
	err = s.db.QueryRow(ctx,
		`SELECT u.id, COALESCE(tm.tenant_id::text, '')
		 FROM users u
		 LEFT JOIN tenant_members tm ON tm.user_id = u.id
		 WHERE u.github_id = $1
		 LIMIT 1`,
		githubID,
	).Scan(&uid, &tid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", false, nil
		}
		return "", "", false, fmt.Errorf("onboard: get user tenant: %w", err)
	}
	return uid, tid, true, nil
}

// JoinTenant validates an invitation token and inserts the user into the tenant.
func (s *OnboardService) JoinTenant(ctx context.Context, in JoinTenantInput) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("onboard: begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var tenantID, role string
	err = tx.QueryRow(ctx,
		`UPDATE invitations SET accepted_at = NOW()
		 WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
		 RETURNING tenant_id, role`,
		in.InvitationToken,
	).Scan(&tenantID, &role)
	if err != nil {
		return fmt.Errorf("onboard: invalid or expired invitation token: %w", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO tenant_members (tenant_id, user_id, role)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (tenant_id, user_id) DO NOTHING`,
		tenantID, in.UserID, role,
	)
	if err != nil {
		return fmt.Errorf("onboard: insert tenant_member: %w", err)
	}

	return tx.Commit(ctx)
}
