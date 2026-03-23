-- Migration 003: Add AI planner metadata columns to study_plans
-- Non-destructive: uses ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- Safe to run multiple times.

ALTER TABLE public.study_plans
  ADD COLUMN IF NOT EXISTS rebalance_logic    text,
  ADD COLUMN IF NOT EXISTS focus_message      text,
  ADD COLUMN IF NOT EXISTS planner_source     text not null default 'llm',
  ADD COLUMN IF NOT EXISTS planner_model      text,
  ADD COLUMN IF NOT EXISTS planner_input_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS used_fallback      boolean not null default false,
  ADD COLUMN IF NOT EXISTS last_rebalanced_at timestamptz;

-- Optional: add a check constraint on planner_source (skip if already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'study_plans_planner_source_check'
  ) THEN
    ALTER TABLE public.study_plans
      ADD CONSTRAINT study_plans_planner_source_check
      CHECK (planner_source IN ('llm', 'fallback'));
  END IF;
END
$$;
