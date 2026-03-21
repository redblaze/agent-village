import { getAgentById, getMemoriesForContext, getVisitorMemories } from '../db/agents.js';
import { getRecentDiaryEntries } from '../db/feed.js';
import { sessionExists } from '../services/session.js';

// ── 1. Owner chat context ────────────────────────────────────────────────────

export async function buildOwnerContext(agent) {
  const memories    = await getMemoriesForContext(agent.id, 'owner');
  const recentDiary = await getRecentDiaryEntries(agent.id, 5);

  let visitorMemories = [];
  try {
    visitorMemories = await getVisitorMemories(agent.id);
  } catch (err) {
    // Non-fatal — owner conversation continues without visitor context
    console.error('Failed to fetch visitor memories (non-fatal):', err);
  }

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

// ── 2. Visitor chat context ──────────────────────────────────────────────────

export async function buildVisitorContext(agent, isFirstMessage) {
  // getMemoriesForContext filters source='owner' — visitor memories (source='visitor') are
  // intentionally excluded here. If cross-session visitor continuity is added in the future,
  // use getVisitorMemoryBySession(agentId, sessionId) — NOT getVisitorMemories — to avoid
  // surfacing one visitor's name/details to a different visitor.
  const memories    = await getMemoriesForContext(agent.id, 'stranger');
  const recentDiary = await getRecentDiaryEntries(agent.id, 5);

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

// ── Express middleware: resolve system prompt before route handler ────────────

export async function resolveContext(req, res, next) {
  try {
    // Ensure agent is always populated — trust middleware only sets req.agent for owners
    const agent = req.agent ?? await getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    req.agent = agent;

    if (req.trustLevel === 'owner') {
      req.systemPrompt = await buildOwnerContext(agent);
    } else {
      // Determine isFirstMessage via sessionExists only (avoids touching lastUsed on session)
      const sessionId      = req.body?.sessionId;
      const isFirstMessage = !sessionId || !sessionExists(sessionId);
      req.systemPrompt = await buildVisitorContext(agent, isFirstMessage);
    }
    next();
  } catch (err) {
    // Match the error response format used by the route handler — preserves existing behavior
    console.error('POST /agents/:id/message error:', err);
    res.status(500).json({ error: 'Failed to process message' });
  }
}
