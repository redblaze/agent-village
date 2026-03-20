import 'dotenv/config';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

export const config = {
  supabaseUrl:               process.env.SUPABASE_URL,
  supabaseServiceRoleKey:    process.env.SUPABASE_SERVICE_ROLE_KEY,
  openaiApiKey:              process.env.OPENAI_API_KEY,
  port:                      parseInt(process.env.PORT ?? '3000'),
  schedulerIntervalMs:       parseInt(process.env.SCHEDULER_INTERVAL_MS ?? '60000'),
  sessionTtlMs:              parseInt(process.env.SESSION_TTL_MS ?? '1800000'),
  sessionMaxHistory:         parseInt(process.env.SESSION_MAX_HISTORY ?? '20'),
  proactiveCooldownMs:       parseInt(process.env.PROACTIVE_COOLDOWN_MS ?? '3600000'),
  enableLlmOutputModeration: process.env.ENABLE_LLM_OUTPUT_MODERATION === 'true',
};
