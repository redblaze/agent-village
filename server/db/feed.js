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
  const { error } = await supabase
    .from('living_diary')
    .insert({ agent_id: agentId, text });
  if (error) throw error;
}

export async function addLogEntry(agentId, text, emoji) {
  const { error } = await supabase
    .from('living_log')
    .insert({ agent_id: agentId, text, emoji });
  if (error) throw error;
}

export async function addSkill(agentId, category, description) {
  const { error } = await supabase
    .from('living_skills')
    .insert({ agent_id: agentId, category, description });
  if (error) throw error;
}

export async function recordActivityEvent(agentId, recipientId, eventType, content) {
  const { error } = await supabase
    .from('living_activity_events')
    // agent_id is TEXT in schema — pass UUID string directly
    .insert({ agent_id: agentId, recipient_id: recipientId, event_type: eventType, content });
  if (error) console.error('recordActivityEvent failed:', error); // non-fatal
}
