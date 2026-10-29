-- Hardening 2026-10-29 (pre-merge review): foreign keys whose referenced rows are deleted in normal operation had no
-- index on the referencing column, so every deleted parent row made Postgres scan the child table:
--   * notifications -> push_outbox / car_task_notices: housekeeping's daily 90-day prune, close_request /
--     restore_closed_request taking a notice back (ON DELETE CASCADE / SET NULL);
--   * push_subscriptions -> push_outbox: the 180-day prune and push-dispatch's 404/410 pruning (ON DELETE CASCADE);
--   * rides -> proposals (ride_id, applied_ride_id), requests.join_ride_id, ride_change_parties, waitlist_groups:
--     apply_solver_result deletes every unpinned draft ride of the week on a full re-solve (one scan per table per ride);
--   * proposal_parties.request_id: read directly by _close_request and the proposal lookups by party request.
-- Partial where the column is mostly null. Plain CREATE INDEX: these tables are small and migrations run in a transaction.

create index if not exists push_outbox_notification_id_idx on public.push_outbox (notification_id);
create index if not exists push_outbox_subscription_id_idx on public.push_outbox (subscription_id);
create index if not exists car_task_notices_notification_id_idx on public.car_task_notices (notification_id)
  where notification_id is not null;
create index if not exists proposals_ride_id_idx on public.proposals (ride_id) where ride_id is not null;
create index if not exists proposals_applied_ride_id_idx on public.proposals (applied_ride_id) where applied_ride_id is not null;
create index if not exists requests_join_ride_id_idx on public.requests (join_ride_id) where join_ride_id is not null;
create index if not exists ride_change_parties_ride_id_idx on public.ride_change_parties (ride_id);
create index if not exists waitlist_groups_ride_id_idx on public.waitlist_groups (ride_id) where ride_id is not null;
create index if not exists proposal_parties_request_id_idx on public.proposal_parties (request_id) where request_id is not null;
