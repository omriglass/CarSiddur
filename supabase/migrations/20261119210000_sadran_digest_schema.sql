-- SN1 (owner 2026-11-18, REQ item 255): fewer Sadran notices on active weeks. Production 2026-11-18: this week's Sadran
-- got 18 `request_changed` notices in 24 h. A member's change / a request left waiting is queued here per Sadran and
-- told as one combined notice on the next `app.tick()` (`flush_sadran_digests`); an edit the server settled on its
-- own (the request kept or moved its booking) is dropped. A request left waiting is told only to a Sadran who turned
-- on `profiles.sadran_waitlist_notices` ("התראות סדרן בשבועות פעילים", off by default).

create table public.sadran_digest_items (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  week_start date not null,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null references public.requests(id) on delete cascade,
  kind text not null check (kind in ('changed', 'waitlisted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (department_id, week_start) references public.weeks(department_id, week_start) on delete cascade,
  unique (recipient_id, request_id, kind)
);
comment on table public.sadran_digest_items is
  'SN1 (REQ item 255): request changes / waiting requests queued for one combined Sadran notice per tick. Server-only (no policies).';
create index sadran_digest_items_request_idx on public.sadran_digest_items (request_id);
create index sadran_digest_items_week_idx on public.sadran_digest_items (department_id, week_start);
alter table public.sadran_digest_items enable row level security;
alter table public.sadran_digest_items force row level security;
create trigger sadran_digest_items_set_updated_at before update on public.sadran_digest_items
  for each row execute function public.set_updated_at();

alter table public.profiles add column sadran_waitlist_notices boolean not null default false;
comment on column public.profiles.sadran_waitlist_notices is
  'SN1 (REQ item 255): the combined Sadran notice also counts requests that went to the waiting list. Off by default.';
grant select (sadran_waitlist_notices) on public.profiles to authenticated;

-- Copy (owner-approved 2026-11-19).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'request_changed'::public.notification_event, ch, 'digest', 'שינויים בבקשות', '{{digestLine}}', 'שינויים בבקשות', '{{digestLine}}'
from unnest(array['inbox', 'push']::public.notification_channel[]) ch
on conflict (event, channel, coalesce(variant, '')) do nothing;
insert into public.text_fragments (key, body) values
  ('sadran_digest.changed', '{{n}} בקשות השתנו'),
  ('sadran_digest.changed_one', 'בקשה אחת השתנתה'),
  ('sadran_digest.waitlisted', '{{n}} נכנסו להמתנה'),
  ('sadran_digest.waitlisted_one', 'בקשה אחת נכנסה להמתנה')
on conflict (key) do nothing;
