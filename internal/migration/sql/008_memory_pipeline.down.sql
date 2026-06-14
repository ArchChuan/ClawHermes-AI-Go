-- internal/migration/sql/008_memory_pipeline.down.sql
DROP INDEX IF EXISTS idx_entities_name_type;
DROP INDEX IF EXISTS idx_entities_scope;
ALTER TABLE entities DROP COLUMN IF EXISTS last_seen;
ALTER TABLE entities DROP COLUMN IF EXISTS occurrence_count;
ALTER TABLE entities DROP COLUMN IF EXISTS scope_layer;
ALTER TABLE entities DROP COLUMN IF EXISTS confidence;
ALTER TABLE entities DROP COLUMN IF EXISTS agent_id;
ALTER TABLE entities DROP COLUMN IF EXISTS user_id;

ALTER TABLE memory_entries DROP COLUMN IF EXISTS enriched_at;
ALTER TABLE memory_entries DROP COLUMN IF EXISTS scope_layer;
ALTER TABLE memory_entries DROP COLUMN IF EXISTS token_estimate;
ALTER TABLE memory_entries DROP COLUMN IF EXISTS keywords;
ALTER TABLE memory_entries DROP COLUMN IF EXISTS conversation_id;

DROP TABLE IF EXISTS memory_token_budgets;
DROP TABLE IF EXISTS memory_summaries;
DROP TABLE IF EXISTS memory_outbox;
