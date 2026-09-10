-- Owner decision: proposals are not a tool for a day that is already published — "live
-- coordination happens directly (WhatsApp/in person), not through the app" (matches
-- 20260910090000_expire_proposals_on_day_publication.sql, which already expires a `sent`
-- proposal the moment its day goes public). That migration left a gap: nothing stopped the
-- board from *creating* or *sending* a proposal for an already-public day in the first
-- place — it would just die silently on the next tick (or, for a draft that is never sent,
-- expire_proposals() only touches status='sent' rows, so a draft could sit forever and
-- still be sent after the fact).
--
-- Exemption: "ask to join" (`p_created_via = 'ask_to_join'`) is NOT a Sadran-composed
-- negotiation — it is filed by submit_request() itself, straight to a temporary car's
-- owner, whenever a member asks to join a ride on a temporary car (REQ §7.3, §13.43;
-- consistency decision 19), and submit_request() does not gate that on week phase. A
-- member can legitimately ask to join a published (even live) day's temporary-car ride;
-- the owner/Sadran still needs to see and answer that ask, so both create_proposal() and
-- send_proposal() exempt created_via='ask_to_join' from this guard. (Regular Sadran-composed
-- proposals, created_via='sadran', get no such exemption in either function.)
--
-- create_proposal() and send_proposal() both have several in-place patches applied via
-- pg_get_functiondef()/replace() (20260907095100, 20260907095300, 20260907095400,
-- 20260907095600, 20260910090000). Patch the live definitions rather than reproduce the
-- whole body, so none of those earlier patches are silently dropped.
-- REQ §7.3/§13.29 (see also §66); DATA_MODEL.md §3.8, §6.

do $migration$
declare
  def text;
  old_guard text := $old$  if p_created_via is null or p_created_via not in ('sadran','ask_to_join') then raise exception 'not_authorized'; end if;
  if p_created_via = 'sadran' and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  elsif p_created_via = 'ask_to_join' and v_req.requester_id <> (select auth.uid())
        and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;$old$;
  new_guard text := $new$  if p_created_via is null or p_created_via not in ('sadran','ask_to_join') then raise exception 'not_authorized'; end if;
  if p_created_via = 'sadran' and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  elsif p_created_via = 'ask_to_join' and v_req.requester_id <> (select auth.uid())
        and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  -- Owner decision (20260910098000): a proposal cannot be created for a day that is
  -- already published — that day's coordination happens directly, not through the app.
  -- "Ask to join" is exempt: it is filed by submit_request(), not composed by the Sadran,
  -- and still needs to reach the temporary car's owner even on a published/live day.
  if p_created_via <> 'ask_to_join'
     and public.is_day_public(v_req.department_id, v_req.week_start,
       (coalesce(v_req.depart_at, v_req.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;$new$;
begin
  def := pg_get_functiondef('public.create_proposal(uuid,uuid,public.proposal_type,jsonb,text,uuid[],text)'::regprocedure);
  if strpos(def, old_guard) = 0 then raise exception 'unexpected_create_proposal_guard'; end if;
  def := replace(def, old_guard, new_guard);
  execute def;
end;
$migration$;

do $migration$
declare
  def text;
  old_guard text := $old$  if v_prop.status<>'draft' then raise exception 'proposal_not_draft'; end if;$old$;
  new_guard text := $new$  if v_prop.status<>'draft' then raise exception 'proposal_not_draft'; end if;
  -- Owner decision (20260910098000): the day may have gone public between draft and send
  -- (create_proposal() guards at creation time, but a draft sitting unsent is never touched
  -- by expire_proposals(), which only expires status='sent' rows) — re-check at send time.
  -- Same "ask to join" exemption as create_proposal().
  if v_prop.created_via <> 'ask_to_join'
     and public.is_day_public(v_prop.department_id, v_prop.week_start,
       (coalesce(v_request.depart_at, v_request.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;$new$;
begin
  def := pg_get_functiondef('public.send_proposal(uuid,public.notification_channel[],uuid,integer)'::regprocedure);
  if strpos(def, old_guard) = 0 then raise exception 'unexpected_send_proposal_guard'; end if;
  def := replace(def, old_guard, new_guard);
  execute def;
end;
$migration$;
