-- Accepted coordinator shifts use the same bounded preparation-gap exception as board edits.
-- REQ §7.3; DATA_MODEL proposal application.
do $migration$
declare def text:=pg_get_functiondef('public.apply_proposal(uuid)'::regprocedure); old_text text;
begin
  old_text:=$$      if v_req.trip_shape<>'round_trip' then raise exception 'one_way_requires_relay_assignment'; end if;$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_shift_window'; end if;
  def:=replace(def,old_text,old_text||$$
      if v_prop.created_via='sadran' then
        gap_override:=public.prepare_manual_ride_window((v_prop.payload->>'car_id')::uuid,v_prop.week_start,
          coalesce((v_prop.payload->>'depart_at')::timestamptz,v_existing.starts_at,v_req.depart_at),
          coalesce((v_prop.payload->>'return_at')::timestamptz,v_existing.ends_at,v_req.return_at),v_existing.id);
      end if;$$);
  old_text:=$$        update public.rides set car_id=(v_prop.payload->>'car_id')::uuid,$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_shift_update'; end if;
  def:=replace(def,old_text,$$        update public.rides set turnaround_override_minutes=gap_override,car_id=(v_prop.payload->>'car_id')::uuid,$$);
  old_text:='driver_id,status,is_pinned,pin_reason,created_by)';
  if strpos(def,old_text)=0 then raise exception 'unexpected_shift_insert_columns'; end if;
  def:=replace(def,old_text,'driver_id,status,is_pinned,pin_reason,created_by,turnaround_override_minutes)');
  old_text:=$$true,'PROPOSAL_APPLIED',v_prop.created_by) returning id into v_ride_id;$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_shift_insert_values'; end if;
  def:=replace(def,old_text,$$true,'PROPOSAL_APPLIED',v_prop.created_by,gap_override) returning id into v_ride_id;$$);
  execute def;
end;
$migration$;
