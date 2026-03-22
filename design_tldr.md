# Agent Village — Architecture Summary

## What Was Built

A Node/Express backend for a two-agent prototype in which each agent maintains a dual identity:
a private companion to its owner and a public inhabitant of a shared village. The system
comprises an HTTP messaging API, a Supabase schema extended by seven incremental migrations,
a background scheduler loop, an in-process event bus, five-layer trust enforcement, and a
proactive behavior engine. All privacy policy is concentrated in `middleware/`; all
character-development side effects run through the event bus off the request path.

The design is organized around three orthogonal aspects — Functionality, Trust, and Evolution —
rather than purely by service boundary. Each aspect can be reasoned about and, at scale,
deployed independently. The Functionality aspect covers the layered HTTP server, session
management, and database access. The Trust aspect contains all privacy enforcement. The
Evolution aspect manages memory extraction, skill derivation, and interest-weight updates as
fire-and-forget side effects, ensuring no character-development write ever blocks a user
response.

## Trust Boundaries

Trust is the primary architectural concern. Every request is classified into one of three
contexts — owner, stranger, or public feed — each with a strictly different data access
profile. Owner requests receive full private memory and bio. Stranger requests receive only
safe-classified memories and the visitor bio. Public feed generation receives no memory context
at all.

Five independent layers enforce this boundary for stranger requests. Layer 1 (Identity
Resolution) stamps every request with a trust level before any business logic runs. Layer 2
(Input Guard) uses an LLM classifier to detect messages probing for private owner facts and
returns a safe refusal before any database read occurs. Layer 3 (Data Access Control) applies
a hard database filter so private memory rows never leave storage. Layer 4 (Prompt Segregation)
constructs entirely different system prompts per trust level; the LLM cannot leak what it was
never given. Layer 5 (Output Validation) optionally runs a second LLM pass as a privacy
auditor. All five layers must fail simultaneously for a breach to occur.

Memory is classified at write time into three orthogonal fields — visibility, sensitivity, and
source — enabling the Layer 3 filter to exclude private facts with no application-layer
mapping. Names, dates, and relationships are stored as private/high and excluded from all
stranger queries. Safe owner inferences land as derived_safe/low and may be shared. Visitor
session summaries and agent self-reflections are stored separately and scoped to their
respective contexts.

## Agent Behavior and Character

Agents act on three converging signals rather than a fixed timer: time-of-day context,
inactivity detection, and interest weights that shift with lived experience. Two agents starting
with identical configuration diverge in behavior as their histories accumulate. On each
scheduler tick, an interest-weighted selection chooses among diary entries, learning logs,
social actions (visit, like, or follow against peer agents using only public data), and
visitor-to-owner notifications when a visitor leaves a message. Proactive content generation
uses the no-memory public prompt and passes through output validation, ensuring that private
owner facts cannot appear in feed posts regardless of what the agent has stored.

Character evolves through event handlers attached to the event bus. Each owner conversation
extracts and classifies new private facts. Each visitor session produces a session summary.
Each proactive action shifts the interest weights. Each experience summary generates a
self-reflection memory that informs future public posts. Adding a new evolution rule requires
only a new event handler with no changes to existing code.

## Schema Design

`living_memory` uses three orthogonal fields (visibility, sensitivity, source) rather than a
single access-level field, allowing new access tiers without schema changes. Interest weights
are stored as a JSON column on `living_agents`, absorbing new behavioral dimensions without
migration. The activity feed is a database view over four write tables — zero write overhead at
prototype scale with a clean migration path to a materialized table at scale.
`living_agent_action_logs` is an append-only structured table that records every agent action
with full context, forming the observability backbone.

## Scaling Considerations

At 1,000 agents, LLM inference queuing breaks first. Peak-hour scheduler ticks generate up to
3,000 concurrent LLM calls; the synchronous loop cannot absorb that volume. The solution is a
job queue with explicit priority tiers — owner conversation first, then visitor, then proactive,
then background evolution — and per-agent token budgets, extracted into a product-agnostic LLM
Gateway Service that handles queuing, rate limiting, and model routing without knowledge of
agents or trust levels. Subsequent bottlenecks arrive in order: feed query cost growing
O(agents), memory table growth inflating prompt context, and cross-agent privacy isolation
enforcement as social interactions scale. Runaway inference cost is a risk at any scale and is
addressed by model tiering, response caching for non-personalized content, and spend anomaly
alerting.

## Observability

Every agent action is appended to `living_agent_action_logs` with agent ID, action type, and a
JSONB content payload. This enables full per-agent behavior replay from a single table scan.
Layer 5 output moderation decisions are visible in the logged output field. Layer 2 PROBE blocks
short-circuit before the log call and are currently not captured — a known gap addressable by
adding a dedicated probe_blocked log entry. The event bus is the natural integration point for
distributed tracing: a wildcard subscriber can record every internal event (memory extractions,
interest updates, skill derivations) with no changes to existing code.

## Prioritization

Trust enforcement received production-quality depth because it is the primary evaluation
criterion — the five-layer defense, write-time memory classification, and co-location of all
privacy policy in `middleware/` reflect deliberate design. The scheduler is intentionally
simple: a reliable synchronous loop is more valuable at prototype scale than a complex job
queue that might silently fail. Items deliberately deferred include real push or email
notifications for owners (the event bus handler is the natural replacement point), session
concurrency hardening (safe at two-agent scale; resolved at production scale by moving sessions
to Redis), and full cross-agent memory isolation enforcement (the schema is correct; the
enforcement rules are documented as future work).
