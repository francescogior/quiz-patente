create table if not exists public.question_explanations (
  question_id bigint primary key,
  question_text text not null,
  topic text,
  correct_answer boolean not null,
  image_path text,
  true_explanation text not null,
  false_explanation text not null,
  key_point text not null,
  confidence text not null check (confidence in ('alta', 'media', 'bassa')),
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.explanation_reports (
  id bigserial primary key,
  question_id bigint not null,
  reason text not null check (reason in ('wrong', 'incomplete', 'unclear')),
  message text,
  page_url text,
  explanation_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.question_explanations enable row level security;
alter table public.explanation_reports enable row level security;

revoke all on table public.question_explanations from anon, authenticated;
revoke all on table public.explanation_reports from anon, authenticated;

grant select, insert, update on table public.question_explanations to service_role;
grant insert, select on table public.explanation_reports to service_role;
grant usage, select on sequence public.explanation_reports_id_seq to service_role;

create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_login_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  email text not null,
  code_hash text not null,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_exam_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  exam_id text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  used_ms integer not null check (used_ms >= 0),
  total_questions integer not null check (total_questions > 0),
  correct_count integer not null check (correct_count >= 0),
  error_count integer not null check (error_count >= 0),
  passed boolean not null,
  finish_reason text not null check (finish_reason in ('manual', 'timeout')),
  answers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, exam_id)
);

create index if not exists app_login_codes_lookup_idx
  on public.app_login_codes (email, code_hash, expires_at desc)
  where consumed_at is null;

create index if not exists app_sessions_lookup_idx
  on public.app_sessions (token_hash, expires_at desc);

create index if not exists user_exam_results_user_finished_idx
  on public.user_exam_results (user_id, finished_at desc);

alter table public.app_users enable row level security;
alter table public.app_login_codes enable row level security;
alter table public.app_sessions enable row level security;
alter table public.user_exam_results enable row level security;

revoke all on table public.app_users from anon, authenticated;
revoke all on table public.app_login_codes from anon, authenticated;
revoke all on table public.app_sessions from anon, authenticated;
revoke all on table public.user_exam_results from anon, authenticated;

grant select, insert, update on table public.app_users to service_role;
grant select, insert, update on table public.app_login_codes to service_role;
grant select, insert, delete on table public.app_sessions to service_role;
grant select, insert, update on table public.user_exam_results to service_role;
