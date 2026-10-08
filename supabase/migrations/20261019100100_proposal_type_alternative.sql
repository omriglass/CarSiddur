-- REQ §13.112 (a): a new proposal type for plan B -- the Sadran proposes serving an unmet request as the
-- member's own alternative הקפצה (payload: the placement, see DATA_MODEL "Plan B"). `alter type … add value`
-- alone in its own file (CLAUDE.md Conventions).
alter type public.proposal_type add value 'alternative';
