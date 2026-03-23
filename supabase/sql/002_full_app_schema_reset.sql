begin;

create extension if not exists pgcrypto;

drop table if exists public.doubt_attachments cascade;
drop table if exists public.doubt_messages cascade;
drop table if exists public.doubt_threads cascade;
drop table if exists public.practice_attempts cascade;
drop table if exists public.practice_sessions cascade;
drop table if exists public.revision_reviews cascade;
drop table if exists public.revision_items cascade;
drop table if exists public.study_plan_items cascade;
drop table if exists public.study_plans cascade;
drop table if exists public.user_subject_confidence cascade;
drop table if exists public.user_exam_settings cascade;
drop table if exists public.profiles cascade;
drop table if exists public.auth_sessions cascade;
drop table if exists public.questions cascade;
drop table if exists public.app_users cascade;

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.auth_sessions (
  token text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table public.profiles (
  id uuid primary key references public.app_users(id) on delete cascade,
  full_name text not null default 'Lakshay Student',
  target_exam text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_exam_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  exam_type text not null check (exam_type in ('JEE', 'NEET', 'UPSC')),
  target_date date,
  daily_hours_target integer not null default 2 check (daily_hours_target >= 0 and daily_hours_target <= 16),
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, exam_type)
);

create table public.user_subject_confidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  subject text not null,
  confidence_level integer not null check (confidence_level >= 1 and confidence_level <= 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, subject)
);

create table public.study_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'archived')),
  week_start_date date not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.study_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.study_plans(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  subject text not null,
  topic text not null,
  type text not null check (type in ('study', 'revision', 'test')),
  source text not null default 'ai',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  exam_type text not null default 'JEE' check (exam_type in ('JEE', 'NEET', 'UPSC')),
  subject text not null,
  topic text not null,
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard', 'adaptive')),
  prompt text not null,
  options jsonb not null default '{}'::jsonb,
  correct_option text not null,
  solution_steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.practice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  module text,
  topic text,
  difficulty text not null default 'adaptive' check (difficulty in ('easy', 'medium', 'hard', 'adaptive')),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'abandoned')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  score_percent numeric(5,2) not null default 0,
  accuracy_percent numeric(5,2) not null default 0,
  time_spent_sec integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.practice_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.practice_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  selected_option text,
  is_correct boolean,
  time_spent_sec integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.revision_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  subject text not null,
  topic text not null,
  origin text not null default 'adaptive' check (origin in ('diagnostic', 'adaptive', 'manual')),
  risk_level text not null default 'medium' check (risk_level in ('critical', 'high', 'medium', 'low')),
  retention_estimate numeric(5,2) not null default 70,
  last_review_at timestamptz,
  next_review_at timestamptz,
  queue_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.revision_reviews (
  id uuid primary key default gen_random_uuid(),
  revision_item_id uuid not null references public.revision_items(id) on delete cascade,
  outcome text not null check (outcome in ('easy', 'ok', 'hard')),
  next_interval_hours integer not null default 24,
  notes text,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.doubt_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  title text not null default 'Latest Doubt Thread',
  rag_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.doubt_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.doubt_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content_text text not null,
  structured_response jsonb,
  confidence numeric(5,4),
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.doubt_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.doubt_messages(id) on delete cascade,
  bucket text not null default 'doubt-attachments',
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  file_size_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_app_users_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger trg_exam_settings_updated_at
before update on public.user_exam_settings
for each row execute function public.set_updated_at();

create trigger trg_subject_confidence_updated_at
before update on public.user_subject_confidence
for each row execute function public.set_updated_at();

create trigger trg_study_plans_updated_at
before update on public.study_plans
for each row execute function public.set_updated_at();

create trigger trg_study_plan_items_updated_at
before update on public.study_plan_items
for each row execute function public.set_updated_at();

create trigger trg_questions_updated_at
before update on public.questions
for each row execute function public.set_updated_at();

create trigger trg_practice_sessions_updated_at
before update on public.practice_sessions
for each row execute function public.set_updated_at();

create trigger trg_revision_items_updated_at
before update on public.revision_items
for each row execute function public.set_updated_at();

create trigger trg_doubt_threads_updated_at
before update on public.doubt_threads
for each row execute function public.set_updated_at();

create index idx_auth_sessions_user_id on public.auth_sessions(user_id);
create index idx_user_exam_settings_user_id on public.user_exam_settings(user_id, updated_at desc);
create index idx_user_subject_confidence_user_id on public.user_subject_confidence(user_id);
create index idx_study_plans_user_id_status on public.study_plans(user_id, status, generated_at desc);
create index idx_study_plan_items_plan_id_starts_at on public.study_plan_items(plan_id, starts_at);
create index idx_questions_exam_topic_diff on public.questions(exam_type, topic, difficulty);
create index idx_practice_sessions_user_id_started_at on public.practice_sessions(user_id, started_at desc);
create index idx_practice_attempts_session_id_created_at on public.practice_attempts(session_id, created_at desc);
create index idx_revision_items_user_id_updated_at on public.revision_items(user_id, updated_at desc);
create index idx_revision_items_user_origin_updated_at on public.revision_items(user_id, origin, updated_at desc);
create index idx_revision_reviews_item_reviewed_at on public.revision_reviews(revision_item_id, reviewed_at desc);
create index idx_doubt_threads_user_id_updated_at on public.doubt_threads(user_id, updated_at desc);
create index idx_doubt_messages_thread_created_at on public.doubt_messages(thread_id, created_at);
create index idx_doubt_attachments_message_id on public.doubt_attachments(message_id);

insert into public.app_users (id, email, password)
values ('00000000-0000-0000-0000-000000000001', 'admin@lakshay.local', 'admin')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, target_exam)
values ('00000000-0000-0000-0000-000000000001', 'admin', 'JEE')
on conflict (id) do update set full_name = excluded.full_name, target_exam = excluded.target_exam;

insert into public.questions (exam_type, subject, topic, difficulty, prompt, options, correct_option, solution_steps)
values
(
  'JEE',
  'Physics',
  'Gauss''s Law',
  'adaptive',
  'A uniformly charged sphere has total charge Q and radius R. What is the electric field for r < R?',
  '{"A":"E proportional to r","B":"E proportional to 1/r","C":"E is constant","D":"E = 0"}'::jsonb,
  'A',
  '["Use Gauss''s law with a spherical Gaussian surface.","Only enclosed charge contributes for radius r.","Result scales linearly with r."]'::jsonb
),
(
  'JEE',
  'Chemistry',
  'Chemical Kinetics',
  'medium',
  'For a first-order reaction, what is the unit of rate constant k?',
  '{"A":"s^-1","B":"mol L^-1 s^-1","C":"L mol^-1 s^-1","D":"dimensionless"}'::jsonb,
  'A',
  '["For first order, rate = k[A].","So k has unit of time inverse."]'::jsonb
),
(
  'JEE',
  'Mathematics',
  'Definite Integration',
  'hard',
  'Evaluate integral from 0 to 1 of x^2 dx.',
  '{"A":"1/2","B":"1/3","C":"1/4","D":"1"}'::jsonb,
  'B',
  '["Integral of x^2 is x^3/3.","Substitute limits 1 and 0.","Result is 1/3."]'::jsonb
)
on conflict do nothing;

commit;
