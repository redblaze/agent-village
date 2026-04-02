-- Drop the unique constraint that was required by the old upsert-based visitor memory.
-- The constraint living_memory_session_unique UNIQUE (agent_id, session_id) was added in
-- add_visitor_memory_support.sql to support upsertVisitorMemory's onConflict clause.
-- With the new per-turn insert approach, multiple rows per session are required.
-- Safe to run: upsertVisitorMemory is no longer called after this change.
ALTER TABLE living_memory DROP CONSTRAINT IF EXISTS living_memory_session_unique;
