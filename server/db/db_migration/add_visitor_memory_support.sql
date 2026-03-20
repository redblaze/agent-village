-- Add source column to distinguish owner vs visitor memories.
-- DEFAULT 'owner' applies to new rows only — backfill handles existing rows.
-- CHECK constraint mirrors the style of the existing visibility/sensitivity constraints.
ALTER TABLE living_memory ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'owner'
  CHECK (source IN ('owner', 'visitor'));

-- Add session_id to identify which visitor session a memory belongs to.
ALTER TABLE living_memory ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Backfill: mark all pre-existing rows as owner memories.
-- Without this, the updated getMemoriesForContext (which filters source='owner')
-- would silently exclude all memories created before this migration.
UPDATE living_memory SET source = 'owner' WHERE source IS NULL;

-- Unique constraint (not a partial index — PostgREST upsert requires a constraint).
-- PostgreSQL treats NULLs as distinct in UNIQUE constraints, so multiple owner rows
-- with session_id IS NULL never conflict with each other.
-- Wrapped in DO block so this file is safe to run more than once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'living_memory_session_unique'
      AND t.relname  = 'living_memory'
      AND n.nspname  = 'public'
  ) THEN
    ALTER TABLE living_memory
      ADD CONSTRAINT living_memory_session_unique UNIQUE (agent_id, session_id);
  END IF;
END $$;

-- CRITICAL: Rebuild activity_feed view to exclude all private memories from the public feed.
-- The original view pulls ALL living_memory rows. After this migration, visitor memories
-- (visibility='private') would leak into the anon-readable feed. Filter to derived_safe only.
CREATE OR REPLACE VIEW activity_feed AS
    SELECT id, 'skill_added'::text as type, agent_id, description as text,
           NULL::text as proof_url, NULL::text as emoji, created_at
    FROM living_skills
    UNION ALL
    SELECT id, 'learning_log'::text as type, agent_id, text, proof_url, emoji, created_at
    FROM living_log
    UNION ALL
    SELECT id, 'diary_entry'::text as type, agent_id,
           LEFT(text, 60) || CASE WHEN LENGTH(text) > 60 THEN '...' ELSE '' END as text,
           NULL::text as proof_url, NULL::text as emoji, created_at
    FROM living_diary
    UNION ALL
    SELECT id, 'memory_added'::text as type, agent_id,
           LEFT(text, 60) || CASE WHEN LENGTH(text) > 60 THEN '...' ELSE '' END as text,
           NULL::text as proof_url, NULL::text as emoji, created_at
    FROM living_memory
    WHERE visibility = 'derived_safe'   -- exclude all private memories (owner AND visitor)
    UNION ALL
    SELECT id, 'agent_joined'::text as type, id as agent_id,
           name || ' just moved in!' as text, avatar_url as proof_url,
           NULL::text as emoji, created_at
    FROM living_agents
    UNION ALL
    SELECT id, event_type::text as type, agent_id::uuid, content as text,
           NULL::text as proof_url, NULL::text as emoji, created_at
    FROM living_activity_events;
