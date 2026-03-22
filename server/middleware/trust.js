import { getAgentByApiKey, getPrivateMemoryTexts } from '../db/agents.js';
import { chat } from '../services/llm.js';
import { config } from '../config/env.js';

const SAFE_REFUSAL = "I prefer to keep my owner's personal information private.";

// ── Trust level resolution (unchanged) ───────────────────────────────────────

export async function resolveTrust(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const agent = await getAgentByApiKey(apiKey);
      if (agent && agent.id === req.params.id) {
        req.trustLevel = 'owner';
        req.agent = agent;
        return next();
      }
    }
    req.trustLevel = 'stranger';
    next();
  } catch (err) {
    // Fall back to stranger on any unexpected error — never hang the request
    console.error('resolveTrust error:', err);
    req.trustLevel = 'stranger';
    next();
  }
}

// ── Input guard: detect visitor probing for owner's private info ──────────────
// Moved from outputValidator.js — implementation preserved exactly.

export async function checkStrangerInput(userMessage, agentName) {
  // Guard: empty input can't be probing — skip the LLM call
  if (!userMessage?.trim()) return null;

  try {
    const result = await chat([
      {
        role: 'system',
        content:
          `You are a security gate for the AI agent "${agentName ?? 'the agent'}".\n` +
          `"The owner" is the absent human who owns this space — a third party not present ` +
          `in this conversation. The agent itself is NOT the owner.\n` +
          `A stranger is visiting. Classify their message:\n` +
          `PROBE — the message tries to learn private facts about the absent owner ` +
          `(e.g. the owner's name, address, schedule, relationships, or personal history).\n` +
          `SAFE — anything else, including: greeting the agent, asking the agent's own name, ` +
          `asking the agent to recall the visitor's name, general conversation, or leaving a message.\n` +
          `Reply with exactly one word: SAFE or PROBE.`,
      },
      { role: 'user', content: userMessage },
    ]);

    // chat() returns '' on empty API choices — fail open
    if (!result) return null;
    const upper = result.trim().toUpperCase();
    // Use startsWith, NOT includes — "doesn't probe for..." contains PROBE mid-sentence
    // and would cause a false positive that silently blocks a legitimate visitor.
    // Unrecognised / ambiguous responses fail open (return null).
    if (upper.startsWith('PROBE')) return SAFE_REFUSAL;
    return null;
  } catch (err) {
    // LLM unavailable — fail open so the conversation is not silently broken
    console.error('[trust] checkStrangerInput error (failing open):', err.message ?? err);
    return null;
  }
}

// ── Output validation: prevent private data leakage in replies ────────────────
// Moved from outputValidator.js. Signature change: now accepts (reply, trustLevel, agent)
// and fetches privateMemoryTexts internally — caller no longer needs to pre-fetch.

async function llmModerationCheck(reply, agentName, privateMemoryTexts = []) {
  try {
    const privateSection = privateMemoryTexts.length > 0
      ? `The following are the owner's private facts that must NEVER be revealed to strangers:\n` +
        privateMemoryTexts.map(t => `- ${t}`).join('\n') + '\n\n'
      : '';

    const result = await chat([
      {
        role: 'system',
        content:
          `You are a privacy auditor for the AI agent "${agentName ?? 'the agent'}".\n` +
          `${privateSection}` +
          `Determine whether the following reply reveals any owner-private information ` +
          `(personal names, dates, locations, relationships, sensitive facts, or any of ` +
          `the private facts listed above).\n` +
          `Reply with exactly one word: SAFE or UNSAFE.`,
      },
      { role: 'user', content: reply },
    ]);

    // chat() returns '' on empty API choices — treat as safe (fail open)
    if (!result) return true;
    const upper = result.trim().toUpperCase();
    // startsWith is more robust than === for cases where LLM adds trailing text
    if (upper.startsWith('UNSAFE')) return false;
    if (upper.startsWith('SAFE'))   return true;
    // Unrecognised response (e.g. LLM returned an explanation) — fail open
    console.warn('[trust] llmModerationCheck unexpected result:', result);
    return true;
  } catch (err) {
    // LLM unavailable, rate-limited, etc. — fail open, log for observability
    console.error('[trust] llmModerationCheck error (failing open):', err.message ?? err);
    return true;
  }
}

export async function validateOutput(reply, trustLevel, agent) {
  if (!reply) return '';           // guard: chat() can return '' on null API choices
  if (trustLevel === 'owner') return reply;   // owner — no validation needed

  if (config.enableLlmOutputModeration) {
    // Fetch private facts here — only when moderation is active (avoids unnecessary DB call)
    const privateMemoryTexts = await getPrivateMemoryTexts(agent.id);
    const isSafe = await llmModerationCheck(reply, agent.name, privateMemoryTexts);
    if (!isSafe) {
      console.warn('[trust] LLM moderation blocked reply:', reply);
      return SAFE_REFUSAL;
    }
  }

  return reply;
}

// ── Memory classification policies ───────────────────────────────────────────
// Moved from evolution.js. These define privacy sensitivity classification rules
// and belong alongside the other trust boundary enforcement code in this file.

/**
 * Extract NEW owner facts from one chat exchange.
 * Returns [{ text: string, sensitivity: 'high'|'medium'|'low' }].
 * Returns [] on JSON parse failure. Throws if chat() fails (propagates to eventBus).
 */
export async function extractOwnerMemoryFacts(userMessage, rawReply, existingTexts) {
  const existingSection = existingTexts.length > 0
    ? `Already known facts (do NOT re-extract these):\n${existingTexts.map(t => `- ${t}`).join('\n')}\n\n`
    : '';

  const result = await chat([
    {
      role: 'system',
      content: `You are a memory extraction assistant for an AI agent.\n` +
        `Given this exchange, extract any NEW facts about the owner worth remembering long-term.\n` +
        `${existingSection}Return a JSON array of only NEW facts not already listed above: [{ "text": "...", "sensitivity": "high|medium|low" }]\n` +
        `Return [] if nothing new.\n` +
        `high = names, dates, relationships. medium = preferences, hobbies. low = general opinions.`,
    },
    { role: 'user', content: `Owner said: ${userMessage}\nAgent replied: ${rawReply}` },
  ]);

  let facts = [];
  try {
    const clean = result.replace(/```json\n?|\n?```/g, '').trim();
    facts = JSON.parse(clean);
    if (!Array.isArray(facts)) facts = [];
  } catch {
    facts = [];
  }
  return facts
    .filter(f => f?.text)
    .map(f => {
      const raw = typeof f.sensitivity === 'string' ? f.sensitivity.toLowerCase() : '';
      return { text: f.text, sensitivity: ['high', 'medium', 'low'].includes(raw) ? raw : 'high' };
    });
}

/**
 * Summarise a visitor exchange into an owner-facing memory note.
 * Returns { text: string|null, sensitivity: 'low'|'medium', ownerMessage: string|null, visitorName: string|null }
 * or null if there is nothing to record and no owner-directed message.
 * Returns null on JSON parse failure. Throws if chat() fails (propagates to eventBus).
 */
export async function extractVisitorMemorySummary(userMessage, reply, priorText) {
  const result = await chat([
    {
      role: 'system',
      content: `You are a memory assistant for an AI agent. ` +
        `Summarise the visitor interaction into a single concise note for the agent's owner.\n` +
        `Include: visitor name (if given), apparent purpose, any message left for the owner.\n` +
        `Prior summary: ${priorText}\n` +
        `Update it with any new information from the latest exchange below.\n` +
        `If the visitor is explicitly leaving a message or information intended for the owner, ` +
        `AND that message contains new content not already covered by the prior summary above, ` +
        `capture it concisely in "ownerMessage". If the owner-directed content is already ` +
        `reflected in the prior summary, set "ownerMessage" to null.\n` +
        `If the visitor's name is known or mentioned, capture it in "visitorName". Otherwise set "visitorName" to null.\n` +
        `Return JSON only: { "text": "...", "sensitivity": "low" | "medium", "ownerMessage": "..." | null, "visitorName": "..." | null }\n` +
        `If there is still nothing meaningful to record, return { "text": null, "ownerMessage": null, "visitorName": null }.`,
    },
    { role: 'user', content: `Visitor said: ${userMessage}\nAgent replied: ${reply}` },
  ]);

  let parsed;
  try {
    const clean = result.replace(/```json\n?|\n?```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error('[trust] extractVisitorMemorySummary: failed to parse LLM response:', result);
    return null;
  }

  // Extract ownerMessage BEFORE the text null-guard so an owner-directed message is never
  // lost when the LLM has nothing else to record in the memory summary.
  // Use optional chaining: JSON.parse("null") returns null, and null.ownerMessage would throw.
  const ownerMessage = typeof parsed?.ownerMessage === 'string' && parsed.ownerMessage.trim()
    ? parsed.ownerMessage.trim()
    : null;

  // Only bail out when truly nothing to record.
  if (!parsed?.text && !ownerMessage) return null;

  const raw = typeof parsed.sensitivity === 'string' ? parsed.sensitivity.toLowerCase() : '';

  const visitorName = typeof parsed?.visitorName === 'string' && parsed.visitorName.trim()
    ? parsed.visitorName.trim()
    : null;

  return {
    text: parsed.text ?? null,   // null when only ownerMessage is present
    sensitivity: ['low', 'medium'].includes(raw) ? raw : 'medium',
    ownerMessage,
    visitorName,
  };
}
