-- internal/migration/sql/008_memory_pipeline.up.sql
-- Memory pipeline tables (per-tenant schema, applied via tenant provisioning)
-- This migration is a marker; actual DDL is in tenant_schema.sql.
-- For existing tenants, run this DDL against each tenant schema.

-- Outbox for reliable message publishing
CREATE TABLE IF NOT EXISTS memory_outbox (
    id          BIGSERIAL PRIMARY KEY,
    message_id  TEXT NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_outbox_created ON memory_outbox (created_at);

-- Conversation summaries
CREATE TABLE IF NOT EXISTS memory_summaries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    summary         TEXT NOT NULL,
    covered_until   TIMESTAMPTZ NOT NULL,
    token_count     INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_conv ON memory_summaries (conversation_id, created_at DESC);

-- Token budget tracking per conversation
CREATE TABLE IF NOT EXISTS memory_token_budgets (
    conversation_id UUID PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
    accumulated     INT NOT NULL DEFAULT 0,
    last_reset_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extend memory_entries with pipeline fields
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES chat_conversations(id) ON DELETE SET NULL;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS token_estimate INT NOT NULL DEFAULT 0;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS scope_layer INT NOT NULL DEFAULT 1;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

-- Extend entities with scoping fields
ALTER TABLE entities ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS confidence FLOAT8 NOT NULL DEFAULT 0;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS scope_layer INT NOT NULL DEFAULT 1;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS occurrence_count INT NOT NULL DEFAULT 1;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_entities_scope ON entities (user_id, agent_id, scope_layer);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type ON entities (user_id, COALESCE(agent_id, ''), name, type);
