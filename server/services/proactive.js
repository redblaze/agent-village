import { touchProactiveTimestamp, parseInterests } from '../db/agents.js';
import { addDiaryEntry, addLogEntry, logAgentAction, recordActivityEvent } from '../db/feed.js';
import { generateDiaryEntry, generateLogEntry, performSocialAction } from './agentService.js';
import { selectProactiveAction } from '../middleware/proactivePolicy.js';
import { trigger, respondTo } from './eventBus.js';

export async function runProactiveBehavior(agent) {
  // Reset cooldown FIRST — prevents retry storms if LLM call fails below
  await touchProactiveTimestamp(agent.id);

  // Use agent row already fetched by scheduler — no extra DB call
  const interests = parseInterests(agent);
  const action = selectProactiveAction(interests);

  let socialAction = null;  // captured here so it's in scope for the event trigger below

  if (action === 'diary') {
    const text    = await generateDiaryEntry(agent);
    const diaryId = await addDiaryEntry(agent.id, text);
    logAgentAction(agent.id, 'diary', true, { diary_id: diaryId }).catch(console.error);
  } else if (action === 'learning') {
    const { text, emoji } = await generateLogEntry(agent);
    const logId           = await addLogEntry(agent.id, text, emoji);
    logAgentAction(agent.id, 'learning', true, { log_id: logId }).catch(console.error);
  } else {
    const result = await performSocialAction(agent);
    if (result) {
      ({ socialAction } = result);  // destructuring assignment to outer let
      const { recipient, eventContent } = result;
      const eventId = await recordActivityEvent(agent.id, recipient.id, socialAction, eventContent)
        .catch(err => { console.error('[runProactiveBehavior] recordActivityEvent failed:', err); return null; });
      logAgentAction(agent.id, 'social', true, eventId ? { activity_event_id: eventId } : null).catch(console.error);
    }
  }

  // Fire-and-forget — evolution.js handles all interest increments (Rules 1–3)
  // socialAction is null when: action !== 'social', OR performSocialAction returned null (no peers)
  trigger('proactive_action_run', agent, { action, socialAction });
}

// ── visitor_message_for_owner ─────────────────────────────────────────────────
// Fired by evolution.js when a visitor is detected to be leaving a message for
// the owner. This is a proactive action from the agent — logged in action_logs.
// The console.log is a placeholder for a real notification channel (push/email/SMS).

respondTo('visitor_message_for_owner', async (agent, { messageText, visitorName }) => {
  const from = visitorName ? `from visitor "${visitorName}"` : 'from a visitor';
  console.log(
    `[${agent.name ?? agent.id}] 📨 Agent is notifying its owner — ` +
    `message ${from}: "${messageText}"`
  );
  // logAgentAction never throws (handles errors internally) — no .catch() needed.
  await logAgentAction(agent.id, 'owner_notification', true, {
    message: messageText,
    visitorName: visitorName ?? null,
  });
});
