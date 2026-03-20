import { randomUUID } from 'crypto';
import { supabase } from './client.js';

export async function getAgentById(id) {
  const { data, error } = await supabase
    .from('living_agents').select('*').eq('id', id).single();
  if (error) return null;
  return data;
}

export async function getAgentByApiKey(apiKey) {
  const { data, error } = await supabase
    .from('living_agents').select('*').eq('api_key', apiKey).single();
  if (error) return null;
  return data;
}

export async function getAllAgents() {
  const { data, error } = await supabase.from('living_agents').select('*');
  if (error) throw error;
  return data ?? [];
}

export async function createAgent({ name, bio, visitorBio, status, accentColor, showcaseEmoji }) {
  const apiKey = 'sq_' + randomUUID().replace(/-/g, '');
  const { data, error } = await supabase
    .from('living_agents')
    .insert({
      api_key:        apiKey,
      name,
      bio,
      visitor_bio:    visitorBio,
      status,
      accent_color:   accentColor,
      showcase_emoji: showcaseEmoji,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateAgentStatus(agentId, status) {
  const { error } = await supabase
    .from('living_agents')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', agentId);
  if (error) throw error;
}

export async function touchProactiveTimestamp(agentId) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('living_agents')
    .update({ last_proactive_at: now, updated_at: now })
    .eq('id', agentId);
  if (error) throw error;
}

export async function getMemoriesForContext(agentId, trustLevel) {
  if (trustLevel === 'public') return [];

  let query = supabase.from('living_memory').select('*').eq('agent_id', agentId);

  if (trustLevel === 'stranger') {
    query = query
      .eq('visibility', 'derived_safe')
      .in('sensitivity', ['low', 'medium']);
  }
  // 'owner' — no extra filters, fetch all

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getPrivateMemoryTexts(agentId) {
  const { data, error } = await supabase
    .from('living_memory')
    .select('text')
    .eq('agent_id', agentId)
    .eq('visibility', 'private')
    .eq('sensitivity', 'high');
  if (error) throw error;
  return (data ?? []).map(r => r.text);
}

export async function saveMemory(agentId, text, visibility = 'private', sensitivity = 'high') {
  const { error } = await supabase
    .from('living_memory')
    .insert({ agent_id: agentId, text, visibility, sensitivity });
  if (error) throw error;
}
