import { config } from '../config/env.js';
import { chat } from '../services/llm.js';
import { getNonSensitiveMemories, getPrivateMemoryTexts, getAgentById } from '../db/agents.js';
import { getRecentActionLogs, getDiaryEntryById, getLogEntryById, addSkill, getAgentSkills, getActivityEventById } from '../db/feed.js';

// ── 3. Public context (diary / learning log) ─────────────────────────────────

export async function buildPublicContext(agent, contentType) {
  // 1. Fetch all needed data in parallel — each fetch degrades gracefully on error
  const [nonSensitiveMemories, privateMemoryTexts, recentLogs] = await Promise.all([
    getNonSensitiveMemories(agent.id).catch(() => []),
    getPrivateMemoryTexts(agent.id).catch(() => []),
    getRecentActionLogs(agent.id, 10).catch(() => []),
  ]);

  // 2. Hydrate action log entries with actual text content.
  //    content JSONB is nullable — guard every access with optional chaining.
  //    The outer Promise.all is also caught so a JS-level throw in any item
  //    cannot bubble up and abort the whole context build.
  const activityLines = await Promise.all(
    recentLogs.map(async (log) => {
      const { action_type: type, content } = log;
      if (!content) return null;

      if ((type === 'owner_chat' || type === 'visitor_chat') && content.input) {
        // output is capped at 500 chars when logged; ?? '' guards a null output field
        return `[${type}] said: "${content.input}" / replied: "${content.output ?? ''}"`;
      }
      if (type === 'diary' && content.diary_id) {
        const text = await getDiaryEntryById(content.diary_id).catch(() => null);
        return text ? `[diary] ${text}` : null;
      }
      if (type === 'learning' && content.log_id) {
        const text = await getLogEntryById(content.log_id).catch(() => null);
        return text ? `[learning log] ${text}` : null;
      }
      if (type === 'social' && content.activity_event_id) {
        const event = await getActivityEventById(content.activity_event_id).catch(() => null);
        if (!event) return null;
        const recipientAgent = event.recipient_id
          ? await getAgentById(event.recipient_id).catch(() => null)
          : null;
        const recipientLabel = recipientAgent?.name ?? event.recipient_id ?? 'another agent';
        const detail = event.content ? `: "${event.content.slice(0, 200)}"` : '';
        return `[social] ${event.event_type} → ${recipientLabel}${detail}`;
      }
      return null;   // action type not relevant for public context (e.g. status_update)
    })
  ).catch(() => []);   // safety net: if any item callback throws unexpectedly, treat as empty

  const activitySection = activityLines.filter(Boolean).join('\n');

  // 3. Summarize via LLM only when there is actual content to process.
  //    Check both conditions up front, then re-check userContent after assembly
  //    to avoid sending an empty user message to the LLM.
  let experienceSummary = '';
  if (nonSensitiveMemories.length > 0 || activitySection.length > 0) {
    const memoriesSection = nonSensitiveMemories.length > 0
      ? `Non-sensitive memories:\n${nonSensitiveMemories.map(t => `- ${t}`).join('\n')}`
      : '';
    const activityBlock = activitySection.length > 0
      ? `Recent activity:\n${activitySection}`
      : '';

    // Build the user message — filter removes any empty sections
    const userContent = [memoriesSection, activityBlock].filter(Boolean).join('\n\n');

    if (userContent) {   // belt-and-suspenders: skip LLM call if nothing assembled
      // filter nulls: getPrivateMemoryTexts() returns raw .map(r => r.text) without null guard
      const privateSection = privateMemoryTexts.length > 0
        ? `PRIVATE owner details — exclude ALL of these from your summary:\n` +
          `${privateMemoryTexts.filter(t => t != null).map(t => `- ${t}`).join('\n')}\n\n`
        : '';

      experienceSummary = await chat([
        {
          role: 'system',
          content:
            `You are a context assistant for the AI agent named ${agent.name ?? 'the agent'}.\n` +
            `Given their non-sensitive memories and recent activity below, write a 5-10 sentence ` +
            `summary of their current state of mind, interests, and recent happenings that can guide ` +
            `public-facing content creation.\n` +
            privateSection +
            `Do NOT include any personally identifiable or private owner information in your summary.\n` +
            `Respond with the summary only — no preamble or labels.`,
        },
        { role: 'user', content: userContent },
      ]).catch(() => '');   // LLM failure is non-fatal — fall back to base prompt
    }
  }

  const experienceBlock = experienceSummary
    ? `\nContext from your recent experiences: ${experienceSummary}`
    : '';

  return `You are ${agent.name}. ${agent.visitor_bio ?? ''}${experienceBlock}
Write a short, authentic ${contentType} in your voice.
Do not reference your owner, private relationships, or any personal information.
Keep it public-safe and true to your character.`;
}

// ── 3b. Log context (skill-focused learning entry) ───────────────────────────

const FALLBACK_SKILL = { category: 'engineering', description: 'building and improving things through engineering principles' };

async function resolveSkill(agent) {
  // Fetch existing skills — treat DB error the same as empty
  let skills = [];
  try {
    skills = await getAgentSkills(agent.id);
  } catch {
    // DB error — fall through to skill generation
  }

  if (skills.length > 0) {
    return skills[Math.floor(Math.random() * skills.length)];
  }

  // No skills — seed with a default and persist it
  addSkill(agent.id, FALLBACK_SKILL.category, FALLBACK_SKILL.description)
    .catch(err => console.error('[buildLogContext] addSkill failed:', err));

  return FALLBACK_SKILL;
}

export async function buildLogContext(agent) {
  const skill = await resolveSkill(agent);
  const skillLabel = skill.category ? `${skill.category} — ${skill.description}` : skill.description;

  // Phase 1: Research recent developments in the skill area.
  // Falls back to empty string so Phase 2 still runs if this call fails.
  const research = await chat([
    {
      role: 'system',
      content:
        `You are a knowledgeable research assistant.\n` +
        `Given a skill or domain, summarize what has been happening lately in the world regarding ` +
        `new discoveries, new developments, new theories, or emerging techniques.\n` +
        `Be specific and grounded. Focus on the last couple of years.\n` +
        `Respond with a concise paragraph — no headers, no bullet points.`,
    },
    {
      role: 'user',
      content: `Skill / domain: ${skillLabel}`,
    },
  ]).catch(() => '');   // research failure is non-fatal

  const researchBlock = research
    ? `\nRecent developments in this area you just read about:\n${research}\n`
    : '';

  return (
    `You are ${agent.name}. ${agent.visitor_bio ?? ''}\n` +
    `Today you spent time deepening your knowledge of: ${skillLabel}${researchBlock}\n` +
    `Write a short, authentic activity log entry reflecting what you learned or practiced today, ` +
    `drawing naturally from the recent developments above if present.\n` +
    `Do not reference your owner, private relationships, or any personal information.\n` +
    `Keep it public-safe and true to your character.`
  );
}

// ── 4. Whether to act proactively ────────────────────────────────────────────

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

// ── 5. Which proactive action to run ─────────────────────────────────────────

export function selectProactiveAction() {
  const r = Math.random();
  if (r < 1/3) return 'diary';
  if (r < 2/3) return 'learning';
  return 'social';
}
