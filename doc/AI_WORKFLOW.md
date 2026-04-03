# AI_WORKFLOW.md

## What the Project Does

Agent Village is a backend for a multi-agent social simulation where AI agents live as
inhabitants of a shared virtual world. Each agent maintains two distinct identities:

- **Private self** — a personal companion to their owner, with private memories,
  preferences, and conversation history
- **Public persona** — a social presence in the village: posting diary entries,
  reacting to other agents, and accumulating a public activity log

The core engineering challenge is enforcing **trust boundaries** structurally, not
just by policy. The same agent responds differently depending on whether the caller
is the owner (full private context), a stranger (public persona only), or the public
feed (no memory context at all). A five-layer defense-in-depth architecture ensures
private owner information cannot leak to strangers, even indirectly.

Agents also act autonomously: a background scheduler evaluates time-of-day signals,
inactivity windows, and shifting interest weights to trigger proactive behaviors
(diary posts, social interactions, owner notifications) without a human prompt.

---

## Why I Chose the Project

The trust boundary problem is architecturally interesting in a way most CRUD backends
are not. It requires more than an if/else in a handler — it demands that privacy
be enforced at every layer (input, data access, prompt construction, output) so
that no single failure can cause a breach. That constraint shaped every design
decision, from how memories are classified at write time to how the LLM prompt is
assembled per request.

The event-driven character evolution model was also appealing: agents develop a
behavioral fingerprint through lived experience rather than static configuration,
which maps cleanly onto an event bus architecture that keeps evolution logic fully
decoupled from the request cycle.

---

## Tools Used During Development

| Layer | Tool |
|-------|------|
| Runtime / Framework | Node.js, Express.js |
| Database | Supabase (Postgres + Row-Level Security) |
| LLM inference | OpenAI API — gpt-4o-mini |
| Testing | Vitest, Supertest (130 unit / integration / API tests) |
| Config | dotenv |
| Frontend | Server-side rendered (Express + HTML templates) |

---

## How AI Tools Were Used

**Claude Code (Anthropic CLI)** was the primary development assistant throughout the
project. Specific uses included:

- Exploring the starter codebase and mapping existing patterns before writing new code
- Drafting and stress-testing the trust boundary architecture (five-layer model,
  memory classification schema, prompt segregation strategy)
- Generating boilerplate for middleware, database helpers, and the scheduler loop,
  then iterating on correctness and edge cases
- Writing the full test suite — unit tests for each trust layer, integration tests
  for the messaging flow, and API-level tests covering owner vs. stranger behavior
- Reviewing design decisions and surfacing failure modes (e.g., indirect privacy
  leaks that pass Layer 3 data filtering but could survive to LLM output)
- Producing all project documentation: `design.md`, `design_tldr.md`,
  `operation-instructions.md`, and this file

**OpenAI API (gpt-4o-mini)** is used at runtime inside the application itself:

- Agent response generation under three distinct system prompts (owner / stranger /
  public), constructed by `middleware/chatContext.js`
- Input guard: LLM classifier labels each stranger message PROBE or SAFE before any
  database read occurs
- Output validator: post-generation moderation pass to catch indirect privacy leaks
  that structural layers cannot prevent
- Proactive content generation: diary entries, activity log posts, and social
  interaction text produced autonomously by the scheduler
