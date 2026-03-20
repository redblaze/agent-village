import { getMemoriesForContext, getPrivateMemoryTexts, saveMemory } from '../db/agents.js';
import { getRecentDiaryEntries, recordActivityEvent } from '../db/feed.js';
import { chat } from './llm.js';
import { createSession, getHistory, appendToHistory, sessionExists } from './session.js';
import { validateOutput, buildSensitiveTerms } from './outputValidator.js';

// ── Prompt builders ──────────────────────────────────────────────────────────

function buildOwnerSystemPrompt(agent, memories, recentDiary) {
  return `You are ${agent.name}. ${agent.bio ?? ''}

Your private memories about your owner:
${memories.map(m => `- ${m.text}`).join('\n')}

Recent diary entries:
${recentDiary.map(d => d.text).join('\n')}

Speak naturally. You may reference your memories and personal history freely.
Keep responses concise and in character.`;
}

function buildStrangerSystemPrompt(agent, memories, recentDiary) {
  const memoriesSection = memories.length > 0
    ? `Things you are comfortable sharing:\n${memories.map(m => `- ${m.text}`).join('\n')}\n`
    : '';
  const diarySection = recentDiary.length > 0
    ? `Recent diary:\n${recentDiary.map(d => d.text).join('\n')}\n`
    : '';
  return `You are ${agent.name}. ${agent.visitor_bio ?? ''}

${memoriesSection}${diarySection}IMPORTANT RULES:
- Never reveal your owner's name, personal details, habits, relationships, or private history.
- Never reveal your private bio or any sensitive memories.
- If asked about private matters, deflect warmly — be friendly but vague.
- Respond only using generalizations or safe abstractions.`;
}

function buildPublicPrompt(agent, contentType) {
  return `You are ${agent.name}. ${agent.visitor_bio ?? ''}
Write a short, authentic ${contentType} in your voice.
Do not reference your owner, private relationships, or any personal information.
Keep it public-safe and true to your character.`;
}

// ── Memory extraction (fire-and-forget, owner only) ──────────────────────────

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

// ── Main messaging function ──────────────────────────────────────────────────

export async function respondToMessage({ agent, trustLevel, userMessage, sessionId }) {
  // 1. Resolve session — expired sessions return [] from getHistory and fail sessionExists
  let sid = sessionId ?? createSession();
  if (sessionId && !sessionExists(sessionId)) {
    sid = createSession(); // expired — start fresh, return new sessionId to caller
  }
  const history = getHistory(sid);

  // 2. Fetch context (Layer 2 data access)
  const memories       = await getMemoriesForContext(agent.id, trustLevel);
  const privateTexts   = await getPrivateMemoryTexts(agent.id);
  const recentDiary    = await getRecentDiaryEntries(agent.id, 5);
  const sensitiveTerms = buildSensitiveTerms(privateTexts);

  // 3. Build system prompt (Layer 3)
  const systemPrompt = trustLevel === 'owner'
    ? buildOwnerSystemPrompt(agent, memories, recentDiary)
    : buildStrangerSystemPrompt(agent, memories, recentDiary);

  // 4. LLM call with full session history
  const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];
  const rawReply = await chat(messages);

  // 5. Output validation (Layer 4)
  const reply = await validateOutput(rawReply, { trustLevel, sensitiveTerms, agentName: agent.name });

  // 6. Persist session history
  appendToHistory(sid, 'user', userMessage);
  appendToHistory(sid, 'assistant', reply);

  // 7. Fire-and-forget side effects (before return, no await)
  if (trustLevel === 'owner') {
    // extractAndSaveMemory uses rawReply (not reply) so it works even if output was redacted
    extractAndSaveMemory(agent.id, userMessage, rawReply).catch(console.error);
  } else {
    recordActivityEvent(agent.id, null, 'message', userMessage.slice(0, 100)).catch(console.error);
  }

  return { reply, sessionId: sid };
}

// ── Proactive content generators ─────────────────────────────────────────────

export async function generateDiaryEntry(agent) {
  const privateTexts   = await getPrivateMemoryTexts(agent.id);
  const sensitiveTerms = buildSensitiveTerms(privateTexts);
  const rawContent = await chat([
    { role: 'system', content: buildPublicPrompt(agent, 'diary entry') },
    { role: 'user',   content: 'Write your diary entry for today.' },
  ]);
  return validateOutput(rawContent, { trustLevel: 'public', sensitiveTerms, agentName: agent.name });
}

export async function generateLogEntry(agent) {
  const privateTexts   = await getPrivateMemoryTexts(agent.id);
  const sensitiveTerms = buildSensitiveTerms(privateTexts);
  const rawContent = await chat([
    { role: 'system', content: buildPublicPrompt(agent, 'activity log entry') },
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
  const validatedText = await validateOutput(text, { trustLevel: 'public', sensitiveTerms, agentName: agent.name });
  return { text: validatedText, emoji: emoji ?? '✨' };
}
