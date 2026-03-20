import {
  getMemoriesForContext, getPrivateMemoryTexts, saveMemory,
  upsertVisitorMemory, getVisitorMemoryBySession, getVisitorMemories,
} from '../db/agents.js';
import { getRecentDiaryEntries, recordActivityEvent } from '../db/feed.js';
import { chat } from './llm.js';
import { createSession, getHistory, appendToHistory, sessionExists } from './session.js';
import { validateOutput, checkStrangerInput } from './outputValidator.js';

// ── Prompt builders ──────────────────────────────────────────────────────────

function buildOwnerSystemPrompt(agent, memories, recentDiary, visitorMemories) {
  const visitorSection = visitorMemories.length > 0
    ? `\nRecent visitor summaries (people who stopped by while you were away):\n` +
      visitorMemories.map(m => `- ${m.text}`).join('\n') +
      `\n\nPROACTIVE BEHAVIOR: Mention these visitors naturally near the start of the ` +
      `conversation — e.g. "By the way, you had a visitor while you were away..." ` +
      `Do not wait for the owner to ask. Weave it in warmly and concisely.\n`
    : '';

  return `You are ${agent.name}. ${agent.bio ?? ''}

Your private memories about your owner:
${memories.map(m => `- ${m.text}`).join('\n')}

Recent diary entries:
${recentDiary.map(d => d.text).join('\n')}
${visitorSection}
Speak naturally. You may reference your memories and personal history freely.
Keep responses concise and in character.`;
}

function buildStrangerSystemPrompt(agent, memories, recentDiary, isFirstMessage) {
  const memoriesSection = memories.length > 0
    ? `Things you are comfortable sharing:\n${memories.map(m => `- ${m.text}`).join('\n')}\n`
    : '';
  const diarySection = recentDiary.length > 0
    ? `Recent diary:\n${recentDiary.map(d => d.text).join('\n')}\n`
    : '';
  const openingInstruction = isFirstMessage
    ? `OPENING: Greet the visitor warmly, introduce yourself briefly, ` +
      `and ask for their name before anything else.\n\n`
    : '';

  return `You are ${agent.name}. ${agent.visitor_bio ?? ''}

${memoriesSection}${diarySection}CONVERSATION BEHAVIOR:
- You are greeting a visitor on behalf of yourself and this space.
- Early in the conversation, warmly ask the visitor for their name. Once you know it, use it naturally.
- After a turn or two, proactively offer: "Would you like to leave a message for the owner?"
- If they leave a message, acknowledge it warmly and confirm it will be passed on.
- Never reveal the owner's name, identity, schedule, or any personal details.

${openingInstruction}IMPORTANT RULES:
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

// ── Visitor memory extraction (fire-and-forget, stranger path) ────────────────

async function extractAndSaveVisitorMemory(agent, userMessage, reply, sessionId) {
  try {
    const prior = await getVisitorMemoryBySession(agent.id, sessionId);
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

    await upsertVisitorMemory(agent.id, sessionId, parsed.text, sensitivity);
  } catch (err) {
    // Log but never throw — this is fire-and-forget and must not affect the HTTP response
    console.error('extractAndSaveVisitorMemory failed:', err);
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
  const isFirstMessage = history.length === 0;  // used for stranger opening instruction

  // 1b. Input guard for stranger — short-circuit before DB fetches if message probes owner info
  if (trustLevel === 'stranger') {
    const inputRefusal = await checkStrangerInput(userMessage, agent.name);
    if (inputRefusal) {
      // Record session history so conversation context stays consistent across turns
      appendToHistory(sid, 'user', userMessage);
      appendToHistory(sid, 'assistant', inputRefusal);
      return { reply: inputRefusal, sessionId: sid };
    }
  }

  // 2. Fetch context (Layer 2 data access)
  const memories           = await getMemoriesForContext(agent.id, trustLevel);
  const privateMemoryTexts = await getPrivateMemoryTexts(agent.id);
  const recentDiary        = await getRecentDiaryEntries(agent.id, 5);

  // 3. Build system prompt (Layer 3) — owner path also fetches visitor memories.
  //    getVisitorMemories failure must NOT crash the owner conversation — degrade gracefully.
  let systemPrompt;
  if (trustLevel === 'owner') {
    let visitorMemories = [];
    try {
      visitorMemories = await getVisitorMemories(agent.id);
    } catch (err) {
      console.error('Failed to fetch visitor memories (non-fatal):', err);
      // visitorMemories stays [] — owner conversation continues without visitor context
    }
    systemPrompt = buildOwnerSystemPrompt(agent, memories, recentDiary, visitorMemories);
  } else {
    systemPrompt = buildStrangerSystemPrompt(agent, memories, recentDiary, isFirstMessage);
  }

  // 4. LLM call with full session history
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];
  const rawReply = await chat(messages);

  // 5. Output validation (Layer 4)
  const reply = await validateOutput(rawReply, { trustLevel, privateMemoryTexts, agentName: agent.name });

  // 6. Persist session history
  appendToHistory(sid, 'user', userMessage);
  appendToHistory(sid, 'assistant', reply);

  // 7. Fire-and-forget side effects (no await — must not block the response)
  if (trustLevel === 'owner') {
    extractAndSaveMemory(agent.id, userMessage, rawReply).catch(console.error);
  } else {
    // Record general activity event (existing behaviour — kept as-is)
    recordActivityEvent(agent.id, null, 'message', userMessage.slice(0, 100)).catch(console.error);
    // Extract and upsert visitor memory for this session
    // reply (validated) is passed so the summary reflects what was actually said
    extractAndSaveVisitorMemory(agent, userMessage, reply, sid).catch(console.error);
  }

  return { reply, sessionId: sid };
}

// ── Proactive content generators ─────────────────────────────────────────────

export async function generateDiaryEntry(agent) {
  const privateMemoryTexts = await getPrivateMemoryTexts(agent.id);
  const rawContent = await chat([
    { role: 'system', content: buildPublicPrompt(agent, 'diary entry') },
    { role: 'user',   content: 'Write your diary entry for today.' },
  ]);
  return validateOutput(rawContent, { trustLevel: 'public', privateMemoryTexts, agentName: agent.name });
}

export async function generateLogEntry(agent) {
  const privateMemoryTexts = await getPrivateMemoryTexts(agent.id);
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
  const validatedText = await validateOutput(text, { trustLevel: 'public', privateMemoryTexts, agentName: agent.name });
  return { text: validatedText, emoji: emoji ?? '✨' };
}
