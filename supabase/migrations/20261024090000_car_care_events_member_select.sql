-- REQ §13.122 a (owner 2026-10-10): every member can open a car's page read-only, including when it was
-- last washed / its tires filled. car_care_events was readable only by the car's responsible person, admins
-- and the reporter; department members now read their department's care log too (read-only — writes stay
-- with log_car_care()). An additional permissive SELECT policy, OR-ed with car_care_events_select.
create policy "car_care_events_select_member" on public.car_care_events
  for select to authenticated
  using (public.member_of(department_id));
