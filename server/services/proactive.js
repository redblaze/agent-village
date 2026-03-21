import { touchProactiveTimestamp, getAllAgents } from '../db/agents.js';
import { addDiaryEntry, addLogEntry, logAgentAction, recordActivityEvent } from '../db/feed.js';
import { generateDiaryEntry, generateLogEntry, respondToMessage } from './agentService.js';
import { selectProactiveAction } from '../middleware/proactivePolicy.js';
import { buildVisitorContext } from '../middleware/chatContext.js';

const SOCIAL_ACTIONS = ['follow', 'like', 'visit', 'message'];

async function runSocialAction(actor) {
  // Pick a recipient — exclude self
  let allAgents;
  try {
    allAgents = await getAllAgents();
  } catch (err) {
    console.error('[runSocialAction] getAllAgents failed:', err);
    return;
  }
  const others = allAgents.filter(a => a.id !== actor.id);
  if (others.length === 0) return;  // no other agents to interact with yet

  const recipient    = others[Math.floor(Math.random() * others.length)];
  const socialAction = SOCIAL_ACTIONS[Math.floor(Math.random() * SOCIAL_ACTIONS.length)];

  let eventContent = null;

  if (socialAction === 'message') {
    const userMessage = 'tell me about your latest';
    try {
      const systemPrompt = await buildVisitorContext(recipient, true);
      const { reply } = await respondToMessage({
        agent:       recipient,
        trustLevel:  'stranger',
        userMessage,
        sessionId:   undefined,
        systemPrompt,
      });
      eventContent = reply;
    } catch (err) {
      console.error('[runSocialAction] message exchange failed:', err);
      // eventContent stays null — still record the social event below
    }
  }

  const eventId = await recordActivityEvent(actor.id, recipient.id, socialAction, eventContent)
    .catch(err => { console.error('[runSocialAction] recordActivityEvent failed:', err); return null; });
  return eventId;
}

export async function runProactiveBehavior(agent) {
  // Reset cooldown FIRST — prevents retry storms if LLM call fails below
  await touchProactiveTimestamp(agent.id);

  const action = selectProactiveAction();
  if (action === 'diary') {
    const text    = await generateDiaryEntry(agent);
    const diaryId = await addDiaryEntry(agent.id, text);
    logAgentAction(agent.id, 'diary', true, { diary_id: diaryId }).catch(console.error);
  } else if (action === 'learning') {
    const { text, emoji } = await generateLogEntry(agent);
    const logId           = await addLogEntry(agent.id, text, emoji);
    logAgentAction(agent.id, 'learning', true, { log_id: logId }).catch(console.error);
  } else {
    const eventId = await runSocialAction(agent);
    // undefined = no action taken (no other agents / DB error); skip log entirely
    // null = action taken but recordActivityEvent failed; log with content: null
    // string = success; log with the event ID
    if (eventId !== undefined) {
      logAgentAction(agent.id, 'social', true, eventId ? { activity_event_id: eventId } : null).catch(console.error);
    }
  }
}
