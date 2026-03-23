create table if not exists public.multimodal_video_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  youtube_url text not null,
  video_id text not null,
  video_title text null,
  transcript_language text null,
  transcript_source text null,
  transcript_text text not null,
  transcript_segments_json jsonb not null default '[]'::jsonb,
  notes_markdown text not null,
  concept_summary text not null,
  mermaid_code text not null,
  key_topics text[] not null default '{}'::text[],
  status text not null default 'completed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists multimodal_video_notes_user_created_idx
  on public.multimodal_video_notes (user_id, created_at desc);

create index if not exists multimodal_video_notes_video_idx
  on public.multimodal_video_notes (video_id, created_at desc);

create trigger multimodal_video_notes_updated_at
before update on public.multimodal_video_notes
for each row execute function public.set_updated_at();
