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
