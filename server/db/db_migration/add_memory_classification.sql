-- Migration: Add visibility and sensitivity columns to living_memory
-- Run this in Supabase SQL Editor AFTER setup-database.sql
ALTER TABLE living_memory
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'derived_safe')),
  ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'high'
    CHECK (sensitivity IN ('high', 'medium', 'low'));

CREATE INDEX IF NOT EXISTS idx_living_memory_visibility
  ON living_memory(agent_id, visibility, sensitivity);
