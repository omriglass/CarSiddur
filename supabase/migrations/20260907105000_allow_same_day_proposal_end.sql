-- Merge proposals use the same final-day boundary as requests and ride editing.
do $migration$
declare definition text; old_guard text;
begin
  definition:=pg_get_functiondef('public.create_proposal(uuid,uuid,public.proposal_type,jsonb,text,uuid[],text)'::regprocedure);
  old_guard:='if not public.is_quarter_hour(combined_start) or not public.is_quarter_hour(combined_end)';
  if strpos(definition,old_guard)=0 then raise exception 'unexpected_merge_time_guard'; end if;
  definition:=replace(definition,old_guard,$guard$if not public.is_quarter_hour(combined_start)
        or not (public.is_quarter_hour(combined_end) or (combined_end at time zone 'Asia/Jerusalem')::time=time '23:59')
        or combined_end<=combined_start
        or (combined_end at time zone 'Asia/Jerusalem')::date<>(combined_start at time zone 'Asia/Jerusalem')::date$guard$);
  execute definition;
end;
$migration$;
