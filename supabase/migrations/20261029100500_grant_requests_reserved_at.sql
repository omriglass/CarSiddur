-- REQ §13.153 × §13.154: `requests` is granted column by column (20261028210000, notes stay private); the planning
-- column `reserved_at` (20261029100100) is not private — the board's solver input reads it for the plannedAhead rule.
grant select (reserved_at) on public.requests to authenticated;
