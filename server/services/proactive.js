import { config } from '../config/env.js';
import { touchProactiveTimestamp } from '../db/agents.js';
import { addDiaryEntry, addLogEntry } from '../db/feed.js';
import { generateDiaryEntry, generateLogEntry } from './agentService.js';

export function shouldActProactively(agent) {
  const hour = new Date().getHours();
  const isPeakHour = [9, 18, 22].includes(hour);
  const hoursInactive = (Date.now() - new Date(agent.updated_at)) / 3_600_000;
  const neverActed = !agent.last_proactive_at;

  // Enforce cooldown — don't act again until PROACTIVE_COOLDOWN_MS has passed
  const msSinceLastProactive = agent.last_proactive_at
    ? Date.now() - new Date(agent.last_proactive_at).getTime()
    : Infinity;
  if (msSinceLastProactive < config.proactiveCooldownMs) return false;

  // Fire if: never acted before (first-time), inactive 2+ hours, or peak hour
  return neverActed || hoursInactive > 2 || isPeakHour;
}

export async function runProactiveBehavior(agent) {
  // Reset cooldown FIRST — prevents retry storms if LLM call fails below
  await touchProactiveTimestamp(agent.id);

  const roll = Math.random();
  if (roll < 0.5) {
    const text = await generateDiaryEntry(agent);
    await addDiaryEntry(agent.id, text);
  } else {
    const { text, emoji } = await generateLogEntry(agent);
    await addLogEntry(agent.id, text, emoji);
  }
}
