-- Add 'agent' as a valid memory source for LLM-derived self-reflection memories.
-- Drop and re-add the constraint (PostgreSQL does not support ALTER CONSTRAINT).

ALTER TABLE living_memory DROP CONSTRAINT IF EXISTS living_memory_source_check;

ALTER TABLE living_memory
  ADD CONSTRAINT living_memory_source_check
  CHECK (source IN ('owner', 'visitor', 'agent'));
