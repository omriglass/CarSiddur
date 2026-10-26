-- REQ §13.154 (g): the `plannedAhead` priority rule type (src/solver/rules/plannedAhead.ts) joins the known set.
CREATE OR REPLACE FUNCTION "public"."validate_policy_rules"("_rules" "jsonb") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select not exists (
    select 1 from jsonb_array_elements(_rules) as r
    where (r ->> 'type') not in (
      'rideType', 'distance', 'publicTransport', 'peopleServed',
      'fairness', 'submissionTime', 'flexibilityOffered', 'manualBoost', 'plannedAhead'
    )
  );
$$;
