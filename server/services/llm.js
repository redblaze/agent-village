import OpenAI from 'openai';
import { config } from '../config/env.js';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

// messages: array of { role: 'system'|'user'|'assistant', content: string }
export async function chat(messages, model = 'gpt-4o-mini') {
  const res = await openai.chat.completions.create({ model, messages });
  // Optional chaining guards against unexpected empty choices from the API
  return res.choices?.[0]?.message?.content ?? '';
}
