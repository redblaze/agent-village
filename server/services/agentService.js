import {
  getMemoriesForContext, saveMemory,           // getMemoriesForContext kept: used by extractAndSaveMemory
  upsertVisitorMemory, getVisitorMemoryBySession,
} from '../db/agents.js';
import { logAgentAction } from '../db/feed.js';
import { chat } from './llm.js';
import { createSession, getHistory, appendToHistory, sessionExists } from './session.js';
import { checkStrangerInput, validateOutput } from '../middleware/trust.js';
import { buildPublicContext, buildLogContext } from '../middleware/proactivePolicy.js';

// ── Memory extraction (fire-and-forget, owner only) ───────────────────────────
// Unchanged from current code — getMemoriesForContext still required here for deduplication.

async function extractAndSaveMemory(agentId, userMessage, rawReply) {
  // Fetch all existing memories so the LLM can skip already-known facts
  const existing = await getMemoriesForContext(agentId, 'owner');
  const existingTexts = existing.map(m => m.text);

  const existingSection = existingTexts.length > 0
    ? `Already known facts (do NOT re-extract these):\n${existingTexts.map(t => `- ${t}`).join('\n')}\n\n`
    : '';

  const result = await chat([
    {
      role: 'system',
      content: `You are a memory extraction assistant for an AI agent.
Given this exchange, extract any NEW facts about the owner worth remembering long-term.
${existingSection}Return a JSON array of only NEW facts not already listed above: [{ "text": "...", "sensitivity": "high|medium|low" }]
Return [] if nothing new.
high = names, dates, relationships. medium = preferences, hobbies. low = general opinions.`,
    },
    { role: 'user', content: `Owner said: ${userMessage}\nAgent replied: ${rawReply}` },
  ]);

  // LLM may wrap JSON in markdown fences — strip before parsing
  let facts = [];
  try {
    const clean = result.replace(/```json\n?|\n?```/g, '').trim();
    facts = JSON.parse(clean);
    if (!Array.isArray(facts)) facts = [];
  } catch {
    facts = []; // extraction failed — silently skip
  }
  for (const fact of facts) {
    if (fact?.text) {
      // Normalize sensitivity — LLMs sometimes return "High" or "MEDIUM"
      const raw = typeof fact.sensitivity === 'string' ? fact.sensitivity.toLowerCase() : '';
      const sensitivity = ['high', 'medium', 'low'].includes(raw) ? raw : 'high';
      // Per-fact try/catch — one failed save must not abort the rest of the loop
      try {
        await saveMemory(agentId, fact.text, 'private', sensitivity);
      } catch (err) {
        console.error('Failed to save memory fact:', err);
      }
    }
  }
}

// ── Visitor memory extraction (fire-and-forget, stranger path) ────────────────
// Unchanged from current code.

async function extractAndSaveVisitorMemory(agentId, userMessage, reply, sessionId) {
  try {
    const prior = await getVisitorMemoryBySession(agentId, sessionId);
    const priorText = prior?.text ?? 'none';

    const result = await chat([
      {
        role: 'system',
        content: `You are a memory assistant for an AI agent. ` +
          `Summarise the visitor interaction into a single concise note for the agent's owner.\n` +
          `Include: visitor name (if given), apparent purpose, any message left for the owner.\n` +
          `Prior summary: ${priorText}\n` +
          `Update it with any new information from the latest exchange below.\n` +
          `Return JSON only: { "text": "...", "sensitivity": "low" | "medium" }\n` +
          `If there is still nothing meaningful to record, return { "text": null }.`,
      },
      {
        role: 'user',
        content: `Visitor said: ${userMessage}\nAgent replied: ${reply}`,
      },
    ]);

    // Strip markdown fences before parsing — LLM sometimes wraps JSON in ```json blocks
    const clean = result.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed?.text) return;   // nothing meaningful yet — skip upsert

    // Normalise and clamp sensitivity — visitor memories are never 'high'
    const rawSensitivity = typeof parsed.sensitivity === 'string'
      ? parsed.sensitivity.toLowerCase() : '';
    const sensitivity = ['low', 'medium'].includes(rawSensitivity) ? rawSensitivity : 'medium';

    await upsertVisitorMemory(agentId, sessionId, parsed.text, sensitivity);
  } catch (err) {
    // Log but never throw — this is fire-and-forget and must not affect the HTTP response
    console.error('extractAndSaveVisitorMemory failed:', err);
  }
}

// ── Main messaging function ───────────────────────────────────────────────────
// systemPrompt is now a required parameter — built by resolveContext middleware.
// Steps 2 (context fetch) and 3 (prompt build) removed. isFirstMessage removed (was step 3 only).

export async function respondToMessage({ agent, trustLevel, userMessage, sessionId, systemPrompt }) {
  // 1. Resolve session — expired sessions return [] from getHistory and fail sessionExists
  let sid = sessionId ?? createSession();
  if (sessionId && !sessionExists(sessionId)) {
    sid = createSession(); // expired — start fresh, return new sessionId to caller
  }
  const history = getHistory(sid);

  // 1b. Input guard for stranger — short-circuit before LLM if message probes owner info
  if (trustLevel === 'stranger') {
    const inputRefusal = await checkStrangerInput(userMessage, agent.name);
    if (inputRefusal) {
      // Record session history so conversation context stays consistent across turns
      appendToHistory(sid, 'user', userMessage);
      appendToHistory(sid, 'assistant', inputRefusal);
      return { reply: inputRefusal, sessionId: sid };
    }
  }

  // 2. LLM call with full session history — systemPrompt provided by resolveContext middleware
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];
  const rawReply = await chat(messages);

  // 3. Output validation (Layer 4)
  const reply = await validateOutput(rawReply, trustLevel, agent);

  // 4. Persist session history
  appendToHistory(sid, 'user', userMessage);
  appendToHistory(sid, 'assistant', reply);

  // 5. Fire-and-forget side effects (no await — must not block the response)
  if (trustLevel === 'owner') {
    extractAndSaveMemory(agent.id, userMessage, rawReply).catch(console.error);
    logAgentAction(agent.id, 'owner_chat', false, {
      session_id: sid,
      input:      userMessage.slice(0, 500),
      output:     reply.slice(0, 500),   // log the validated reply, not rawReply
    }).catch(console.error);
  } else {
    extractAndSaveVisitorMemory(agent.id, userMessage, reply, sid).catch(console.error);
    logAgentAction(agent.id, 'visitor_chat', false, {
      session_id: sid,
      input:      userMessage.slice(0, 500),
      output:     reply.slice(0, 500),
    }).catch(console.error);
  }

  return { reply, sessionId: sid };
}

// ── Proactive content generators ──────────────────────────────────────────────
// buildPublicPrompt renamed to buildPublicContext (imported from proactivePolicy.js).
// getPrivateMemoryTexts pre-fetch removed — validateOutput fetches it internally
// only when config.enableLlmOutputModeration is true (lazy fetch, same functional result).

export async function generateDiaryEntry(agent) {
  const rawContent = await chat([
    { role: 'system', content: await buildPublicContext(agent, 'diary entry') },
    { role: 'user',   content: 'Write your diary entry for today.' },
  ]);
  return validateOutput(rawContent, 'public', agent);
}

export async function generateLogEntry(agent) {
  const rawContent = await chat([
    { role: 'system', content: await buildLogContext(agent) },
    { role: 'user',   content: 'Write a short activity log entry. Respond as JSON: {"text":"...","emoji":"..."}' },
  ]);
  let text, emoji;
  try {
    const clean = rawContent.replace(/```json\n?|\n?```/g, '').trim();
    ({ text, emoji } = JSON.parse(clean));
    if (!text) throw new Error('missing text field'); // force fallback if LLM omitted text key
  } catch {
    text = rawContent; emoji = '✨';
  }
  const validatedText = await validateOutput(text, 'public', agent);
  return { text: validatedText, emoji: emoji ?? '✨' };
}
