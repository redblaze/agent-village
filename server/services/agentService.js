import { getAllAgents } from '../db/agents.js';
import { logAgentAction } from '../db/feed.js';
import { chat } from './llm.js';
import { createSession, getHistory, appendToHistory, sessionExists } from './session.js';
import { checkStrangerInput, validateOutput } from '../middleware/trust.js';
import { buildPublicContext, buildLogContext } from '../middleware/proactivePolicy.js';
import { buildVisitorContext } from '../middleware/chatContext.js';
import { trigger } from './eventBus.js';

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
    trigger('answer_to_owner', agent, { userMessage, rawReply, sessionId: sid, isFirstTurn: history.length === 0 });
    logAgentAction(agent.id, 'owner_chat', false, {
      session_id: sid,
      input:      userMessage.slice(0, 500),
      output:     reply.slice(0, 500),
    }).catch(console.error);
  } else {
    trigger('answer_to_visitor', agent, { userMessage, reply, sessionId: sid, isFirstTurn: history.length === 0 });
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

// ── Social action (proactive peer interaction) ────────────────────────────────

const SOCIAL_ACTIONS = ['follow', 'like', 'visit', 'message'];

export async function performSocialAction(actor) {
  // Fetch all agents — treat DB error as "no peers available"
  let allAgents;
  try {
    allAgents = await getAllAgents();
  } catch (err) {
    console.error('[performSocialAction] getAllAgents failed:', err);
    return null;
  }
  const others = allAgents.filter(a => a.id !== actor.id);
  if (others.length === 0) return null;  // no other agents to interact with

  const recipient    = others[Math.floor(Math.random() * others.length)];
  const socialAction = SOCIAL_ACTIONS[Math.floor(Math.random() * SOCIAL_ACTIONS.length)];

  let eventContent = null;
  if (socialAction === 'message') {
    try {
      const systemPrompt = await buildVisitorContext(recipient, true);
      const { reply } = await respondToMessage({
        agent:       recipient,
        trustLevel:  'stranger',
        userMessage: 'tell me about your latest',
        sessionId:   undefined,
        systemPrompt,
      });
      eventContent = reply;
    } catch (err) {
      console.error('[performSocialAction] message exchange failed:', err);
      // eventContent stays null — caller still records the event
    }
  } else if (socialAction === 'follow') {
    eventContent = `${actor.name ?? actor.id} followed ${recipient.name ?? recipient.id}`;
  } else if (socialAction === 'visit') {
    eventContent = `${actor.name ?? actor.id} visited ${recipient.name ?? recipient.id}`;
  } else if (socialAction === 'like') {
    eventContent = `${actor.name ?? actor.id} liked ${recipient.name ?? recipient.id}`;
  }

  return { recipient, socialAction, eventContent };
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
