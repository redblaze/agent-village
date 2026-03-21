-- Migration: add living_agent_action_logs
-- Backward-compatible: creates new table only, no changes to existing tables or views.
-- Run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS living_agent_action_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID        NOT NULL REFERENCES living_agents(id) ON DELETE CASCADE,
  action_type  TEXT        NOT NULL
    CHECK (action_type IN (
      'owner_chat',
      'visitor_chat',
      'diary',
      'learning',
      'status_update',
      'social_with_other_agents'
    )),
  is_proactive BOOLEAN     NOT NULL DEFAULT false,
  content      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_logs_agent_created
  ON living_agent_action_logs(agent_id, created_at DESC);

-- RLS: enable but grant NO anon read — logs contain raw chat content.
-- Service role bypasses RLS in Supabase automatically.
ALTER TABLE living_agent_action_logs ENABLE ROW LEVEL SECURITY;
