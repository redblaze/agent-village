-- Fix: action_type 'social_with_other_agents' was never used by the application.
-- proactive.js writes 'social'; proactivePolicy.js reads 'social'.
-- Drop the old constraint and re-add with the correct value.

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
    'social'
  ));
