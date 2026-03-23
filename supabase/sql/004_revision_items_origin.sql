-- Migration 004: Add origin metadata to revision_items
-- Tracks whether a revision row came from diagnostic, adaptive practice, or manual creation.
-- Safe to run multiple times.

ALTER TABLE public.revision_items
  ADD COLUMN IF NOT EXISTS origin text not null default 'adaptive';

UPDATE public.revision_items
SET origin = 'adaptive'
WHERE origin IS NULL;

ALTER TABLE public.revision_items
  ALTER COLUMN origin SET DEFAULT 'adaptive',
  ALTER COLUMN origin SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'revision_items_origin_check'
  ) THEN
    ALTER TABLE public.revision_items
      ADD CONSTRAINT revision_items_origin_check
      CHECK (origin IN ('diagnostic', 'adaptive', 'manual'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_revision_items_user_origin_updated_at
  ON public.revision_items (user_id, origin, updated_at DESC);
