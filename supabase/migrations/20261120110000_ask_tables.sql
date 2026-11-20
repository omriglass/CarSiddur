-- REQ item 258 (AI1, "Ask in words", phase 1): who may use it, and the record of every conversation.
--
-- ask_access: a row = the admin opted the member in (members cannot opt themselves in, so it is not a profiles
--   column: profiles is updatable by its owner). The member's own "hide it" switch and the disclaimer
--   acknowledgement live on the same row. Written only through RPCs (20261120110100).
-- ask_conversations / ask_turns: written by the `ask` edge function with the service role (one row per turn);
--   members read their own and may only mark a turn 👎 and close their conversation (RPCs); admins read all.
--   Kept one month (housekeeping, 20261120110200).

create table public.ask_access (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  hidden boolean not null default false,
  disclaimer_ack_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger ask_access_updated_at before update on public.ask_access
  for each row execute function public.set_updated_at();

create table public.ask_conversations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  -- open → to_form (left for the prefilled form) → done (the request / edit / cancellation went through);
  -- cancelled = the card's "ביטול"; closed = ✕ with nothing done.
  outcome text not null default 'open'
    constraint ask_conversations_outcome_ck check (outcome in ('open', 'to_form', 'done', 'cancelled', 'closed')),
  result_request_id uuid references public.requests(id) on delete set null,
  -- what the form finally sent, and its difference from the last draft (the "corrected in the form" signal)
  sent jsonb,
  diff jsonb,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ask_conversations_profile_idx on public.ask_conversations (profile_id, created_at desc);
create index ask_conversations_created_idx on public.ask_conversations (created_at);
create trigger ask_conversations_updated_at before update on public.ask_conversations
  for each row execute function public.set_updated_at();

create table public.ask_turns (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ask_conversations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  position smallint not null constraint ask_turns_position_ck check (position >= 1),
  user_text text not null constraint ask_turns_text_ck check (char_length(user_text) between 1 and 1000),
  draft_in jsonb,          -- the draft the turn started from
  raw_answer jsonb,        -- the model's answer as returned
  draft jsonb,             -- after our checks (askNormalize)
  flags text[] not null default '{}',
  error text,              -- machine code (quota, timeout, bad_answer, …)
  prompt_version text not null,
  model text not null,
  latency_ms integer,
  thumbs_down boolean not null default false,
  -- admin: "הוספה לסט הבדיקה" — the right answer for scripts/ai-eval/cases.json
  eval_expect jsonb,
  eval_added_by uuid references public.profiles(id) on delete set null,
  eval_added_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ask_turns_position_uq unique (conversation_id, position)
);
create index ask_turns_profile_idx on public.ask_turns (profile_id);

alter table public.ask_access enable row level security;
alter table public.ask_access force row level security;
alter table public.ask_conversations enable row level security;
alter table public.ask_conversations force row level security;
alter table public.ask_turns enable row level security;
alter table public.ask_turns force row level security;

create policy ask_access_select on public.ask_access for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_admin()));
create policy ask_conversations_select on public.ask_conversations for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_admin()));
create policy ask_turns_select on public.ask_turns for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.ask_access, public.ask_conversations, public.ask_turns from anon, authenticated;
grant select on public.ask_access, public.ask_conversations, public.ask_turns to authenticated;
grant all on public.ask_access, public.ask_conversations, public.ask_turns to service_role;
