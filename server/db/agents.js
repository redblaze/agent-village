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

  let query = supabase
    .from('living_memory')
    .select('*')
    .eq('agent_id', agentId)
    .eq('source', 'owner');          // exclude visitor memories

  if (trustLevel === 'stranger') {
    query = query
      .eq('visibility', 'derived_safe')
      .in('sensitivity', ['low', 'medium']);
  }
  // 'owner' — no additional filters beyond source='owner'

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function upsertVisitorMemory(agentId, sessionId, text, sensitivity) {
  const { error } = await supabase
    .from('living_memory')
    .upsert(
      { agent_id: agentId, session_id: sessionId, text, sensitivity,
        visibility: 'private', source: 'visitor' },
      { onConflict: 'agent_id,session_id' }
    );
  if (error) throw error;
}

export async function getVisitorMemoryBySession(agentId, sessionId) {
  const { data, error } = await supabase
    .from('living_memory')
    .select('text')
    .eq('agent_id', agentId)
    .eq('session_id', sessionId)
    .single();
  if (error) return null;   // PGRST116 = not found (first turn); other errors: degrade gracefully
  return data;
}

export async function getVisitorMemories(agentId) {
  const { data, error } = await supabase
    .from('living_memory')
    .select('text, created_at')
    .eq('agent_id', agentId)
    .eq('source', 'visitor')
    .order('created_at', { ascending: false })
    .limit(10);
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

export async function getNonSensitiveMemories(agentId) {
  const { data, error } = await supabase
    .from('living_memory')
    .select('text')
    .eq('agent_id', agentId)
    .eq('source', 'owner')
    .in('sensitivity', ['low', 'medium']);
  if (error) throw error;
  // filter(t => t != null) guards against rare null text rows so callers never
  // receive null values that would render as "- null" in an LLM prompt
  return (data ?? []).map(r => r.text).filter(t => t != null);
}

export async function saveMemory(agentId, text, visibility = 'private', sensitivity = 'high') {
  const { error } = await supabase
    .from('living_memory')
    .insert({ agent_id: agentId, text, visibility, sensitivity });
  if (error) throw error;
}
