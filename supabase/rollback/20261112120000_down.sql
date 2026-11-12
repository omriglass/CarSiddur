-- Down script for 20261112120000_merge_previews.sql (PF1 B2). The frontend released with that migration calls
-- `merge_previews`: roll the frontend back first (docs/RUNBOOK_ROLLBACK.md), then run this.

drop function if exists public.merge_previews(jsonb);
