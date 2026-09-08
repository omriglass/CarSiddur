-- Publishing must remain available when score calculation is temporarily unavailable.
-- Score snapshots are reporting data: accept valid JSON arrays whether they are complete,
-- empty, or unavailable, so they can be calculated retrospectively.
do $migration$
declare
  definition text;
begin
  select pg_get_functiondef('public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean)'::regprocedure)
    into definition;

  -- The function has evolved across deployed databases. Replace its whole score-validation
  -- section, rather than relying on the exact formatting or set of score checks in one
  -- historical version. Authorization, readiness and stale-input protections stay above it.
  definition := regexp_replace(
    definition,
    $pattern$if jsonb_typeof\(p_profile_scores\).*?select \* into v_prev from public\.siddur_versions$pattern$,
    $replacement$if jsonb_typeof(p_profile_scores) is distinct from 'array'
    or jsonb_typeof(p_policy_scores) is distinct from 'array' then
    raise exception 'invalid_publication_scores';
  end if;
  if p_expected_fingerprint is null then
    raise exception 'stale_input' using errcode='P0409';
  end if;
  -- A missing or incomplete score calculation must never prevent publication.
  -- Scores are a snapshot for later reporting and can be recalculated retrospectively.
  select * into v_prev from public.siddur_versions$replacement$,
    's'
  );

  if definition not like '%Scores are a snapshot for later reporting%' then
    raise exception 'publish_siddur_definition_changed';
  end if;
  execute definition;
end;
$migration$;
