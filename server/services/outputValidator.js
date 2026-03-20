import { chat } from './llm.js';
import { config } from '../config/env.js';

const SAFE_REFUSAL = "I prefer to keep my owner's personal information private.";

// ── LLM output moderation ─────────────────────────────────────────────────────
// Returns true (SAFE) or false (UNSAFE).
// Fail-open on any error — a broken moderation check must not crash the conversation.
// Also fail-open on empty LLM result (chat() returns '' on null choices).
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
    console.warn('[outputValidator] llmModerationCheck unexpected result:', result);
    return true;
  } catch (err) {
    // LLM unavailable, rate-limited, etc. — fail open, log for observability
    console.error('[outputValidator] llmModerationCheck error (failing open):', err.message ?? err);
    return true;
  }
}

// ── LLM input guard ───────────────────────────────────────────────────────────
// Call before the main chat() for stranger messages.
// Returns SAFE_REFUSAL string if the message is probing for owner info; null if safe.
// Fail-open on any error — must never block a legitimate conversation due to a check failure.
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
    console.error('[outputValidator] checkStrangerInput error (failing open):', err.message ?? err);
    return null;
  }
}

// ── Output validation gate ────────────────────────────────────────────────────
// Call before returning any non-owner response (messaging AND public feed posts).
// privateMemoryTexts: array of text strings from getPrivateMemoryTexts() —
//   passed to the LLM moderation check so it can judge against known private facts.
export async function validateOutput(reply, { trustLevel, agentName, privateMemoryTexts = [] }) {
  if (!reply) return '';           // guard: chat() can return '' on null API choices
  if (trustLevel === 'owner') return reply;   // owner — no validation needed

  if (config.enableLlmOutputModeration) {
    // llmModerationCheck is already wrapped in try/catch and fails open — safe to await
    const isSafe = await llmModerationCheck(reply, agentName, privateMemoryTexts);
    if (!isSafe) {
      console.warn('[outputValidator] LLM moderation blocked reply:', reply);
      return SAFE_REFUSAL;
    }
  }

  return reply;
}
