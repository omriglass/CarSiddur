-- REQ §13.93: request_templates gets the same origin safety net as requests
-- (20261004100200): a row inserted without an origin defaults to the requester's
-- default origin for the department, else the department home. Same function —
-- both tables carry department_id/requester_id/origin_id/origin_text.
create trigger request_templates_default_origin before insert on public.request_templates
  for each row execute function public.requests_default_origin();
