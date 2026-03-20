-- Migration: Add last_proactive_at to living_agents
-- Run this in Supabase SQL Editor AFTER setup-database.sql
ALTER TABLE living_agents
  ADD COLUMN IF NOT EXISTS last_proactive_at TIMESTAMPTZ;
