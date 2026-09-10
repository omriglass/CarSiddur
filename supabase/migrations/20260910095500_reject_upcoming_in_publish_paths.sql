-- REQ §13.77 — publish_siddur() and publication_readiness() should never be reachable for
-- an `upcoming` week (the board only lets a Sadran manage the current open/solving week;
-- an upcoming week is read-mostly, shown only to surface pinned series legs). Defensive,
-- clear `week_not_open` guard rather than silently computing readiness/publishing against a
-- week nobody has actually opened yet.
--
-- Both functions have several in-place patches applied via pg_get_functiondef()/replace()
-- (publish_siddur: 20260907092500, 20260907093900, 20260907094100, 20260908150000,
-- 20260909097000, 20260910090000, 20260910091800; publication_readiness unpatched since
-- 20260910091800_publish_forms_waitlist_groups.sql). Patch the live definitions in place
-- rather than reproduce either body in full.
do $migration$
declare
  def text;
  old_publish text := '  perform 1 from public.weeks where department_id=p_department_id and week_start=p_week_start for update;
  if not found then raise exception ''week_not_open''; end if;
  if exists(select 1 from public.weeks where department_id=p_department_id and week_start=p_week_start and phase=''archived'') then raise exception ''week_archived''; end if;';
  new_publish text := '  perform 1 from public.weeks where department_id=p_department_id and week_start=p_week_start for update;
  if not found then raise exception ''week_not_open''; end if;
  if exists(select 1 from public.weeks where department_id=p_department_id and week_start=p_week_start and phase=''archived'') then raise exception ''week_archived''; end if;
  if exists(select 1 from public.weeks where department_id=p_department_id and week_start=p_week_start and phase=''upcoming'') then raise exception ''week_not_open''; end if;';
  old_readiness text := '  if not public.can_manage_week(p_department_id,p_week_start) then raise exception ''not_authorized'';end if;
  for d in select p_week_start+i from generate_series(0,6) i loop';
  new_readiness text := '  if not public.can_manage_week(p_department_id,p_week_start) then raise exception ''not_authorized'';end if;
  if exists(select 1 from public.weeks w where w.department_id=p_department_id and w.week_start=p_week_start and w.phase=''upcoming'') then raise exception ''week_not_open''; end if;
  for d in select p_week_start+i from generate_series(0,6) i loop';
begin
  def := pg_get_functiondef('public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean)'::regprocedure);
  if strpos(def, old_publish) = 0 then raise exception 'unexpected_publish_siddur_week_lookup'; end if;
  def := replace(def, old_publish, new_publish);
  execute def;

  def := pg_get_functiondef('public.publication_readiness(uuid,date)'::regprocedure);
  if strpos(def, old_readiness) = 0 then raise exception 'unexpected_publication_readiness_header'; end if;
  def := replace(def, old_readiness, new_readiness);
  execute def;
end;
$migration$;
