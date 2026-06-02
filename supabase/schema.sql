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
