// Set required env vars before any module is imported.
// This prevents config/env.js from throwing during test module graph evaluation.
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
