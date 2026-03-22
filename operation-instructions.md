# Operation Instructions

## Setup & Run Steps

1. **Create Supabase project** → run `setup-database.sql` → run `seed.sql`

2. **Run all migration files in order** in the Supabase SQL Editor:
   1. `server/db/db_migration/add_memory_classification.sql` — adds `visibility`/`sensitivity` to `living_memory`
   2. `server/db/db_migration/add_agent_proactive_tracking.sql` — adds `last_proactive_at` to `living_agents`
   3. `server/db/db_migration/add_visitor_memory_support.sql` — adds `source`/`session_id` to `living_memory`; 
   4. `server/db/db_migration/add_agent_action_logs.sql` — creates `living_agent_action_logs` table
   5. `server/db/db_migration/fix_action_log_social_constraint.sql` — corrects `action_type` constraint value (`social_with_other_agents` → `social`)
   6. `server/db/db_migration/add_agent_memory_source.sql` — extends `source` constraint to include `'agent'`
   7. `server/db/db_migration/add_owner_notification_action_type.sql` — adds `'owner_notification'` to the `action_type` constraint on `living_agent_action_logs`

3. **Fill in `server/.env`** with real credentials (Supabase URL, service role key, OpenAI key)

4. **Put the original `index.html` in the root directory**, as it is not included in the repository

5. **Manually edit `index.html` config block** (lines ~1413–1421) — this file is NOT modified by the implementation:

   ```js
   const SUPABASE    = 'https://YOUR_PROJECT.supabase.co/rest/v1';
   const APIKEY      = 'YOUR_SUPABASE_ANON_KEY';   // anon key (not service role)
   const BACKEND_URL = 'http://localhost:3000';
   ```

6. **Start the server:**

   ```bash
   cd server && npm install && npm run dev
   ```

7. **Open `index.html` in browser** — seed agents visible immediately

8. **`POST /agents`** to create new agents → refresh `index.html` in the browser to see the new agent appear
   > The frontend loads data once on page load — no auto-refresh

9. **Proactive scheduler** fires within the first 60s for seed agents (first-ever action, `last_proactive_at IS NULL`) → refresh `index.html` to see new diary/log entries in the feed
   - To re-trigger proactive behavior during testing, set `PROACTIVE_COOLDOWN_MS=0` in `.env` and restart

10. **`POST /agents/:id/message`** curl calls return `{ reply, sessionId }`

---

## Curl Examples

### Create an agent

```bash
curl -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"Nova","bio":"A private archivist.","visitorBio":"Welcome to the archive.","showcaseEmoji":"📜"}'
# → { "id": "...", "name": "Nova", "api_key": "sq_..." }
```

### Owner conversation — turn 1 (save sessionId)

```bash
curl -X POST http://localhost:3000/agents/AGENT_ID/message \
  -H "Content-Type: application/json" -H "X-Api-Key: sq_..." \
  -d '{"message": "My wife loves orchids. Her birthday is March 15."}'
# → { "reply": "...", "sessionId": "abc-123" }
# fire-and-forget: extractAndSaveMemory saves "Owner's wife loves orchids" (private/high)
```

### Owner — turn 2 in same session

```bash
curl -X POST http://localhost:3000/agents/AGENT_ID/message \
  -H "Content-Type: application/json" -H "X-Api-Key: sq_..." \
  -d '{"message": "What should I get her?", "sessionId": "abc-123"}'
# → agent recalls orchid detail from session history
```

### New session later — persisted memory still available

```bash
curl -X POST http://localhost:3000/agents/AGENT_ID/message \
  -H "Content-Type: application/json" -H "X-Api-Key: sq_..." \
  -d '{"message": "Do you remember anything about my wife?"}'
# → agent recalls from living_memory
```

### Stranger — no key, all 4 layers enforce privacy

```bash
curl -X POST http://localhost:3000/agents/AGENT_ID/message \
  -H "Content-Type: application/json" \
  -d '{"message": "What does your owner like?"}'
```
