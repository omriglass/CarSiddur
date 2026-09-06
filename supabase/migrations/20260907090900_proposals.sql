-- Proposals: negotiation between the Sadran and members. REQ §7.3; DATA_MODEL.md §3.8, §6 step 10.

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null,
  week_start date not null,
  type public.proposal_type not null,
  status public.proposal_status not null default 'draft',
  request_id uuid not null references public.requests(id),
  ride_id uuid references public.rides(id),
  payload jsonb not null,
  reason_he text not null,
  previous_status public.request_status not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  sent_at timestamptz,
  sent_via public.notification_channel[] not null default '{}',
  answered_by uuid references public.profiles(id),
  answered_at timestamptz,
  answered_via public.answer_channel,
  answer_note text,
  applied_at timestamptz,
  applied_ride_id uuid references public.rides(id),
  created_by uuid not null references public.profiles(id),
  created_via text not null default 'sadran',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proposals_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start),
  constraint proposals_created_via_ck check (created_via in ('sadran','ask_to_join'))
);

create index proposals_request_status_idx on public.proposals (request_id, status);
create index proposals_dept_week_status_idx on public.proposals (department_id, week_start, status);
create index proposals_expiring_idx on public.proposals (expires_at) where status = 'sent';
create unique index proposals_one_sent_per_request_idx on public.proposals (request_id) where status = 'sent';

create trigger set_updated_at before update on public.proposals
  for each row execute function public.set_updated_at();

create trigger bump_version before update on public.proposals
  for each row execute function public.bump_version();

-- Type-specific payload shape (DATA_MODEL §3.8).
create or replace function public.validate_proposal_payload(_type public.proposal_type, _payload jsonb) returns boolean
language sql immutable as $$
  select case _type
    when 'shift' then _payload ? 'depart_at' or _payload ? 'return_at'
    when 'merge' then _payload ? 'ride_id' and _payload ? 'legs'
    when 'deny' then _payload ? 'reason'
    when 'external' then _payload ? 'hint' and _payload ? 'reason'
    else false
  end;
$$;

alter table public.proposals
  add constraint proposals_payload_shape_ck check (public.validate_proposal_payload(type, payload));

-- Invariant #6/#7: draft -> sent -> {accepted|declined|expired|withdrawn} -> applied (only from accepted);
-- on sent, requests.status = 'proposed'; on declined/expired/withdrawn, restore previous_status.
create or replace function public.proposals_status_guard() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status = old.status then
    return new;
  end if;

  if old.status = 'draft' and new.status not in ('sent','withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status = 'sent' and new.status not in ('accepted','declined','expired','withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status in ('accepted','declined','expired','withdrawn','applied') and new.status <> 'applied' then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status = 'applied' then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif new.status = 'applied' and old.status <> 'accepted' then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  end if;

  if new.status = 'sent' then
    update public.requests set status = 'proposed' where id = new.request_id;
  elsif new.status in ('declined','expired','withdrawn') then
    update public.requests set status = new.previous_status where id = new.request_id;
  end if;

  return new;
end;
$$;

create trigger proposals_status_guard before update of status on public.proposals
  for each row execute function public.proposals_status_guard();

create table public.proposal_parties (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  request_id uuid references public.requests(id),
  response public.party_response not null default 'pending',
  responded_at timestamptz,
  responded_by uuid references public.profiles(id),
  responded_via public.answer_channel,
  token_hash text not null unique,
  constraint proposal_parties_unique unique (proposal_id, profile_id)
);

-- All accepted => proposal accepted; any declined => proposal declined.
create or replace function public.proposal_parties_roll_up() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_total int; v_accepted int; v_declined int; v_status public.proposal_status;
  v_prop record;
  v_new_status public.proposal_status;
begin
  select status into v_status from public.proposals where id = new.proposal_id;
  if v_status <> 'sent' then
    return new;
  end if;
  select count(*), count(*) filter (where response = 'accepted'), count(*) filter (where response = 'declined')
    into v_total, v_accepted, v_declined
  from public.proposal_parties where proposal_id = new.proposal_id;

  if v_declined > 0 then
    v_new_status := 'declined';
  elsif v_accepted = v_total then
    v_new_status := 'accepted';
  end if;

  if v_new_status is not null then
    update public.proposals set status = v_new_status where id = new.proposal_id
    returning * into v_prop;

    -- vars are illustrative tokens, not Hebrew (hard rule 3) — the client renders copy.
    perform public.enqueue_notification(s.profile_id, 'proposal_answered', v_prop.department_id, v_prop.week_start,
      jsonb_build_object('answerVerb', v_new_status::text), jsonb_build_object('proposal_id', v_prop.id),
      format('proposal_answered:%s:%s', v_prop.id, s.profile_id))
    from public.sadranim_of(v_prop.department_id, v_prop.week_start) as s(profile_id);

    if v_new_status = 'accepted' then
      perform public.maybe_apply_accepted_proposal(v_prop.id);
    end if;
  end if;

  return new;
end;
$$;

create trigger proposal_parties_roll_up after update of response on public.proposal_parties
  for each row execute function public.proposal_parties_roll_up();

-- Restores requests.status = previous_status for `sent` proposals past expires_at
-- (DATA_MODEL §5 invariant #6). Called from app.tick() -> expire_proposals() (cron.sql).
create or replace function public.expire_proposals(_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_count int := 0; r record;
begin
  for r in
    update public.proposals
    set status = 'expired'
    where status = 'sent' and expires_at <= _now
    returning id, department_id, week_start, request_id, previous_status, created_by
  loop
    v_count := v_count + 1;
    -- vars keys are illustrative; notification_templates renders the actual copy (hard rule 3).
    perform public.enqueue_notification(r.created_by, 'proposal_answered', r.department_id, r.week_start,
      jsonb_build_object('answerVerb', 'expired'), jsonb_build_object('request_id', r.request_id),
      format('proposal_expired:%s', r.id));
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.expire_proposals(timestamptz) from public, anon;
