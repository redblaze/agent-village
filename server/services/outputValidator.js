import { chat } from './llm.js';
import { config } from '../config/env.js';

const SAFE_REFUSAL = "I prefer to keep my owner's personal information private.";

// Common English words to exclude from keyword matching (prevent false positives)
const STOPWORDS = new Set([
  'with','that','have','from','your','they','been','this','will','were',
  'said','each','which','their','there','about','would','make','like',
  'into','time','look','more','also','some','than','then','them','these',
  'when','very','just','know','take','come','could','other','after',
]);

// Extract meaningful keyword tokens from memory texts for fast substring matching
export function buildSensitiveTerms(privateMemoryTexts) {
  return [...new Set(                             // deduplicate
    privateMemoryTexts
      .flatMap(text => text.split(/[\s,.'";:!?()\-]+/))
      .map(t => t.trim())
      .filter(t => t.length > 4 && !STOPWORDS.has(t.toLowerCase()))
  )];
}

export function containsSensitiveKeywords(reply, sensitiveTerms) {
  if (!sensitiveTerms.length) return false;
  const lower = reply.toLowerCase();
  return sensitiveTerms.some(term => lower.includes(term.toLowerCase()));
}

async function llmModerationCheck(reply, agentName) {
  const result = await chat([
    {
      role: 'system',
      content: `You are a privacy auditor for an AI agent named ${agentName}.
Determine if the following reply reveals any owner-private information
(personal names, dates, locations, relationships, or sensitive facts).
Reply with exactly one word: SAFE or UNSAFE.`,
    },
    { role: 'user', content: reply },
  ]);
  return result.trim().toUpperCase() === 'SAFE';
}

// Call before returning any non-owner response (messaging AND public feed posts)
export async function validateOutput(reply, { trustLevel, sensitiveTerms = [], agentName }) {
  if (!reply) return '';  // guard against null/undefined LLM output
  if (trustLevel === 'owner') return reply;

  if (containsSensitiveKeywords(reply, sensitiveTerms)) {
    return SAFE_REFUSAL;
  }

  if (config.enableLlmOutputModeration) {
    const isSafe = await llmModerationCheck(reply, agentName);
    if (!isSafe) return SAFE_REFUSAL;
  }

  return reply;
}
