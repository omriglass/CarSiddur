-- REQ item 249 (a) (owner 2026-11-17, TT1): a way may carry both of its hours. The way there: "לצאת ב־" (the car's
-- depart_at, depart_anchor = 'leave') AND "להגיע עד" (arrive_by); the way back: "בבית עד" (return_at,
-- return_anchor = 'arrive') AND "לצאת משם ב־" (leave_dest_at). So arrive_by no longer implies depart_anchor =
-- 'arrive', nor leave_dest_at return_anchor = 'leave': the anchor still says which hour the car time was worked out
-- from ('arrive' / 'leave' = derived), and a second stated hour sits beside a stated car time. The checks that
-- tied each hour to its anchor go; the presence rules stay in submit_request. Same for saved weekly templates.
alter table public.requests drop constraint requests_arrive_by_anchor_ck;
alter table public.requests drop constraint requests_leave_dest_anchor_ck;
alter table public.request_templates drop constraint request_templates_arrive_by_anchor_ck;
alter table public.request_templates drop constraint request_templates_leave_dest_anchor_ck;
