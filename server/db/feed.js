import { supabase } from './client.js';

export async function getRecentDiaryEntries(agentId, limit = 5) {
  const { data, error } = await supabase
    .from('living_diary')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function addDiaryEntry(agentId, text) {
  const { data, error } = await supabase
    .from('living_diary')
    .insert({ agent_id: agentId, text })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;   // backward-compatible: existing callers ignore return value
}

export async function addLogEntry(agentId, text, emoji) {
  const { data, error } = await supabase
    .from('living_log')
    .insert({ agent_id: agentId, text, emoji })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;   // backward-compatible: existing callers ignore return value
}

export async function logAgentAction(agentId, actionType, isProactive, content = null) {
  const { error } = await supabase
    .from('living_agent_action_logs')
    .insert({ agent_id: agentId, action_type: actionType, is_proactive: isProactive, content });
  if (error) console.error('logAgentAction failed:', error.message); // non-fatal — never throws
}

export async function getRecentActionLogs(agentId, limit = 10) {
  const { data, error } = await supabase
    .from('living_agent_action_logs')
    .select('action_type, content')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getActionLogsWithTimestamp(agentId, limit = 100) {
  const { data, error } = await supabase
    .from('living_agent_action_logs')
    .select('id, action_type, content, created_at')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// Returns all visitor_chat turns for a session in chronological order.
// Each turn: { input: string, output: string, created_at: string }
export async function getVisitorConversationTurns(agentId, sessionId) {
  const { data, error } = await supabase
    .from('living_agent_action_logs')
    .select('content, created_at')
    .eq('agent_id', agentId)
    .eq('action_type', 'visitor_chat')
    .eq('content->>session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) return [];
  return (data ?? []).map(row => ({
    input:      row.content?.input  ?? '',
    output:     row.content?.output ?? '',
    created_at: row.created_at,
  }));
}

export async function getDiaryEntryById(id) {
  const { data, error } = await supabase
    .from('living_diary')
    .select('text')
    .eq('id', id)
    .single();
  if (error) return null;   // not found or DB error — degrade gracefully
  return data?.text ?? null;
}

export async function getLogEntryById(id) {
  const { data, error } = await supabase
    .from('living_log')
    .select('text')
    .eq('id', id)
    .single();
  if (error) return null;   // not found or DB error — degrade gracefully
  return data?.text ?? null;
}

export async function addSkill(agentId, category, description) {
  const { error } = await supabase
    .from('living_skills')
    .insert({ agent_id: agentId, category, description });
  if (error) throw error;
}

export async function getAgentSkills(agentId) {
  const { data, error } = await supabase
    .from('living_skills')
    .select('category, description')
    .eq('agent_id', agentId);
  if (error) throw error;
  return data ?? [];
}

export async function recordActivityEvent(agentId, recipientId, eventType, content) {
  const { data, error } = await supabase
    .from('living_activity_events')
    // agent_id is TEXT in schema — pass UUID string directly
    .insert({ agent_id: agentId, recipient_id: recipientId, event_type: eventType, content })
    .select('id')
    .single();
  if (error) {
    console.error('recordActivityEvent failed:', error); // non-fatal
    return null;
  }
  return data.id;
}

export async function getActivityEventById(id) {
  const { data, error } = await supabase
    .from('living_activity_events')
    .select('event_type, recipient_id, content')
    .eq('id', id)
    .single();
  if (error) return null;   // not found or DB error — degrade gracefully
  return data;
}
