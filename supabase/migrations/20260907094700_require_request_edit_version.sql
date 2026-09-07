-- JSON null must not bypass optimistic concurrency when editing a request.
-- REQ §5.2; DATA_MODEL request version contract.
do $migration$
declare
  definition text := pg_get_functiondef('public.submit_request(jsonb)'::regprocedure);
  old_guard text := $$if payload ? 'expected_version' and v_existing.version <> (payload ->> 'expected_version')::int then$$;
  new_guard text := $$if v_existing.version is distinct from (payload ->> 'expected_version')::int then$$;
begin
  if (length(definition) - length(replace(definition, old_guard, ''))) <> length(old_guard) then
    raise exception 'unexpected_submit_request_version_guard';
  end if;
  execute replace(definition, old_guard, new_guard);
end;
$migration$;
