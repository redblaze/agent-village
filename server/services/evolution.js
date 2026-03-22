import { respondTo } from './eventBus.js';
import { chat } from './llm.js';
import { addSkill, getAgentSkills } from '../db/feed.js';
import { saveMemory, getMemoriesForContext, upsertVisitorMemory, getVisitorMemoryBySession, incrementInterests } from '../db/agents.js';
import { extractOwnerMemoryFacts, extractVisitorMemorySummary } from '../middleware/trust.js';

// ── agent_experience_aggregated ───────────────────────────────────────────────
// Fired by buildPublicContext whenever a non-empty experience context is assembled.
// target: agent object  payload: { userContent: string }

respondTo('agent_experience_aggregated', async (agent, { userContent }) => {
  const result = await chat([
    {
      role: 'system',
      content:
        `You are a skill extraction assistant for an AI agent.\n` +
        `Given the agent's aggregated experience context below (memories and recent activity), ` +
        `identify ONE skill or domain of expertise the agent appears to be developing or practicing.\n` +
        `Return JSON only: { "category": "...", "description": "..." }\n` +
        `- category: short label (e.g. "engineering", "writing", "music")\n` +
        `- description: one sentence describing the specific skill\n` +
        `If no clear skill is evident, return { "category": null, "description": null }.`,
    },
    { role: 'user', content: userContent },
  ]);

  // Bug fix: was unguarded JSON.parse — now wrapped to match other handlers
  let parsed;
  try {
    const clean = result.replace(/```json\n?|\n?```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error('[evolution] agent_experience_aggregated: failed to parse LLM response:', result);
    return;
  }

  if (!parsed?.description) return;  // nothing meaningful extracted

  // Avoid persisting exact duplicate descriptions
  const existing = await getAgentSkills(agent.id);
  const alreadyKnown = existing.some(
    s => s.description.toLowerCase() === parsed.description.toLowerCase()
  );
  if (alreadyKnown) return;

  await addSkill(agent.id, parsed.category ?? null, parsed.description);
});

// ── agent_experience_summarized ───────────────────────────────────────────────
// Fired by buildPublicContext after every non-empty experienceSummary is produced.
// target: agent object  payload: { summary: string }

respondTo('agent_experience_summarized', async (agent, { summary }) => {
  await saveMemory(agent.id, summary, 'derived_safe', 'low', 'agent');
});

// ── answer_to_owner ───────────────────────────────────────────────────────────
// Fired by respondToMessage after every owner chat turn.
// target: agent object  payload: { userMessage: string, rawReply: string, isFirstTurn: boolean }

respondTo('answer_to_owner', async (agent, { userMessage, rawReply, isFirstTurn }) => {
  const existing = await getMemoriesForContext(agent.id, 'owner');
  const existingTexts = existing.map(m => m.text);

  const facts = await extractOwnerMemoryFacts(userMessage, rawReply, existingTexts);
  for (const { text, sensitivity } of facts) {
    try {
      await saveMemory(agent.id, text, 'private', sensitivity);
    } catch (err) {
      console.error('[evolution] Failed to save memory fact:', err);
    }
  }

  // Rule 5: owner conversation → learning +1 on first turn of session
  if (isFirstTurn) {
    incrementInterests(agent.id, { learning: 1 }).catch(err =>
      console.error('[evolution] owner learning increment failed:', err)
    );
  }
});

// ── answer_to_visitor ─────────────────────────────────────────────────────────
// Fired by respondToMessage after every visitor/stranger chat turn.
// target: agent object  payload: { userMessage: string, reply: string, sessionId: string, isFirstTurn: boolean }

respondTo('answer_to_visitor', async (agent, { userMessage, reply, sessionId, isFirstTurn }) => {
  const prior = await getVisitorMemoryBySession(agent.id, sessionId);
  const priorText = prior?.text ?? 'none';

  const summary = await extractVisitorMemorySummary(userMessage, reply, priorText);
  if (summary) {
    await upsertVisitorMemory(agent.id, sessionId, summary.text, summary.sensitivity);
  }

  // Rule 4: visitor session → learning +1 on first turn
  if (isFirstTurn) {
    incrementInterests(agent.id, { learning: 1 }).catch(err =>
      console.error('[evolution] visitor learning increment failed:', err)
    );
  }
});

// ── proactive_action_run ──────────────────────────────────────────────────────
// Fired by runProactiveBehavior after every proactive action completes.
// target: agent  payload: { action: 'diary'|'learning'|'social', socialAction: string|null }
//   socialAction is null when action !== 'social', or when performSocialAction found no peers.

respondTo('proactive_action_run', async (agent, { action, socialAction }) => {
  // Defensive guard — action must be one of the three known types
  if (!['diary', 'learning', 'social'].includes(action)) {
    console.error('[evolution] proactive_action_run: unknown action type:', action);
    return;
  }

  // Build a single merged delta object to avoid multiple read-modify-write round trips.
  const deltas = {};

  // Rule 1: the chosen action's interest is not touched; the other two each gain +1
  for (const type of ['diary', 'learning', 'social']) {
    if (type !== action) deltas[type] = 1;
  }

  // Rule 2: like/follow/visit → social +1
  if (socialAction && ['like', 'follow', 'visit'].includes(socialAction)) {
    deltas.social = (deltas.social ?? 0) + 1;
  }
  // Rule 3: like → diary +1
  if (socialAction === 'like') {
    deltas.diary = (deltas.diary ?? 0) + 1;
  }

  if (Object.keys(deltas).length > 0) {
    incrementInterests(agent.id, deltas).catch(err =>
      console.error('[evolution] proactive_action_run increment failed:', err)
    );
  }
});
