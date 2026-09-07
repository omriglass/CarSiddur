-- Transactional fixtures: no inbox or proposal changes survive this suite.
begin;
create function pg_temp.reject_test_proposal_notification() returns trigger language plpgsql as $$
begin
  if new.data->>'proposal_id'=current_setting('app.test_fail_proposal',true) then raise exception 'fixture_notification_failure';end if;
  return new;
end $$;
create trigger fixture_reject_proposal_notification before insert on public.notifications
  for each row execute function pg_temp.reject_test_proposal_notification();
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103';
  other_member uuid:='00000000-0000-0000-0000-000000000104';
  w date:=public.current_week_start()+84;
  req uuid; old_id uuid; new_id uuid; next_id uuid; old_version int; new_version int;
  old_token_hash text; old_tokens jsonb; new_tokens jsonb; payload jsonb:='{"reason":"Fixture offer"}';
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
    values(dept,w,member,member,'00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',
      ((w+1)+time '08:00') at time zone 'Asia/Jerusalem',((w+1)+time '10:00') at time zone 'Asia/Jerusalem','submitted') returning id into req;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  old_id:=public.create_proposal(req,null,'deny',payload,'First fixture offer');
  old_tokens:=public.send_proposal(old_id);
  select version,token_hash into old_version,old_token_hash from public.proposals where id=old_id;
  new_id:=public.create_proposal(req,null,'deny',payload,'Replacement fixture offer');
  assert (select previous_status='proposed' from public.proposals where id=new_id),'fixture must reproduce draft created during pending offer';
  begin perform public.send_proposal(new_id);raise exception 'duplicate offer sent without replacement consent';
  exception when raise_exception then if sqlerrm<>'proposal_already_sent' then raise;end if;end;
  assert (select status='sent' and token_hash=old_token_hash from public.proposals where id=old_id),'default rejection changed old offer';
  assert (select status='draft' from public.proposals where id=new_id),'default rejection sent replacement';
  begin perform public.send_proposal(old_id);raise exception 'retry silently rotated sent tokens';
  exception when raise_exception then if sqlerrm<>'proposal_not_draft' then raise;end if;end;
  begin perform public.send_proposal(new_id,'{}',old_id,null);raise exception 'missing replacement version allowed';
  exception when sqlstate 'P0409' then null;end;
  begin perform public.send_proposal(new_id,'{}',gen_random_uuid(),old_version);raise exception 'wrong replacement ID allowed';
  exception when sqlstate 'P0409' then null;end;
  begin
    update public.proposals set reason_he='Changed since coordinator loaded' where id=old_id;
    perform public.send_proposal(new_id,'{}',old_id,old_version);
    raise exception 'changed replacement version allowed';
  exception when sqlstate 'P0409' then null;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other_member,'role','authenticated')::text,true);
  begin perform public.send_proposal(new_id,'{}',old_id,old_version);raise exception 'unrelated member replaced offer';
  exception when raise_exception then if sqlerrm<>'not_authorized' then raise;end if;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  -- A failure after expiring the old offer rolls back both transitions and all token writes.
  perform set_config('app.test_fail_proposal',new_id::text,true);
  begin perform public.send_proposal(new_id,'{}',old_id,old_version);raise exception 'injected failure did not occur';
  exception when raise_exception then if sqlerrm<>'fixture_notification_failure' then raise;end if;end;
  perform set_config('app.test_fail_proposal','',true);
  assert (select status='sent' and version=old_version and token_hash=old_token_hash from public.proposals where id=old_id),'failed send expired or changed old offer';
  assert (select status='draft' and previous_status='proposed' from public.proposals where id=new_id),'failed send changed replacement';
  assert (select status='proposed' from public.requests where id=req),'failed send altered request state';
  assert not exists(select 1 from public.notifications where data->>'proposal_id'=new_id::text),'failed send leaked notification';
  new_tokens:=public.send_proposal(new_id,'{}',old_id,old_version);
  assert (select status='expired' from public.proposals where id=old_id),'explicit replacement did not expire old offer';
  assert (select status='sent' and previous_status='submitted' from public.proposals where id=new_id),'replacement lost original previous status';
  assert (select count(*)=1 from public.proposals where request_id=req and status='sent'),'replacement violated single sent offer';
  begin perform public.answer_proposal(old_tokens->'party_tokens'->>member::text,true);raise exception 'expired party token approved';
  exception when raise_exception then if sqlerrm<>'proposal_not_answerable' then raise;end if;end;
  begin perform public.answer_proposal(old_tokens->>'proposal_token',true);raise exception 'expired main token approved';
  exception when raise_exception then if sqlerrm<>'proposal_not_answerable' then raise;end if;end;
  begin perform public.record_answer_on_behalf(old_id,member,true);raise exception 'expired offer manually approved';
  exception when raise_exception then if sqlerrm<>'proposal_not_answerable' then raise;end if;end;
  perform public.answer_proposal(new_tokens->'party_tokens'->>member::text,false);
  assert (select status='submitted' from public.requests where id=req),'declining replacement restored proposed instead of original state';
  -- Partial answers and final acceptance cannot be overwritten, even with a freshly read version.
  old_id:=public.create_proposal(req,null,'deny',payload,'Two-party fixture',array[other_member]);
  old_tokens:=public.send_proposal(old_id);
  next_id:=public.create_proposal(req,null,'deny',payload,'Candidate after answer');
  perform public.record_answer_on_behalf(old_id,member,true);
  select version into old_version from public.proposals where id=old_id;
  begin perform public.send_proposal(next_id,'{}',old_id,old_version);raise exception 'partially answered offer replaced';
  exception when raise_exception then if sqlerrm<>'proposal_replacement_answered' then raise;end if;end;
  perform public.answer_proposal(old_tokens->'party_tokens'->>other_member::text,true);
  select version into old_version from public.proposals where id=old_id;
  begin perform public.send_proposal(next_id,'{}',old_id,old_version);raise exception 'accepted offer replaced';
  exception when sqlstate 'P0409' then null;end;
  assert (select status in ('accepted','applied') from public.proposals where id=old_id),'accepted offer overwritten';
end $$;
set constraints all immediate;
rollback;
