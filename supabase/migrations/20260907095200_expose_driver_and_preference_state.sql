-- Read projections and publication scoring share the persisted driver/preference state.
-- REQ §5, §7–8; DATA_MODEL views.
do $migration$
declare def text;
begin
  def:=regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass,true),';\s*$','');
  if strpos(def,'q.has_luggage')=0 then raise exception 'unexpected_board_served_mapping'; end if;
  def:=replace(def,'q.has_luggage',$$q.has_luggage,'preferred_car_id',q.preferred_car_id,'original_depart_at',q.original_depart_at,'original_return_at',q.original_return_at$$);
  execute 'create or replace view public.v_board_rides with(security_invoker=true) as select existing.*,r.needs_driver,r.turnaround_override_minutes from ('||def||') existing join public.rides r on r.id=existing.id';
  def:=regexp_replace(pg_get_viewdef('public.v_my_requests'::regclass,true),';\s*$','');
  execute 'create or replace view public.v_my_requests with(security_invoker=true) as select existing.*,q.preferred_car_id,q.original_depart_at,q.original_return_at,r.needs_driver,r.turnaround_override_minutes from ('||def||') existing join public.requests q on q.id=existing.request_id left join public.rides r on r.id=existing.ride_id';
  def:=pg_get_functiondef('public.assert_publication_scores(uuid,date,jsonb)'::regprocedure);
  if strpos(def,$$r.status<>'cancelled'$$)=0 then raise exception 'unexpected_publication_served_check'; end if;
  def:=replace(def,$$r.status<>'cancelled'$$,$$r.status<>'cancelled' and not r.needs_driver$$);
  execute def;
end;
$migration$;
