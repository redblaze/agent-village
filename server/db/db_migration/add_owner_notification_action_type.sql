-- Migration: add 'owner_notification' to living_agent_action_logs action_type constraint
-- Run after fix_action_log_social_constraint.sql in Supabase SQL Editor.

ALTER TABLE living_agent_action_logs
  DROP CONSTRAINT living_agent_action_logs_action_type_check;

ALTER TABLE living_agent_action_logs
  ADD CONSTRAINT living_agent_action_logs_action_type_check
  CHECK (action_type IN (
    'owner_chat',
    'visitor_chat',
    'diary',
    'learning',
    'status_update',
    'social',
    'owner_notification'
  ));
