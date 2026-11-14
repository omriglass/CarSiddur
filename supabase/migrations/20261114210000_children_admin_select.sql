-- R20H5 (owner 2026-11-14): an admin reads children's names like the department's members do. Admins already
-- add, edit and delete children everywhere (children_admin_write_*), and request_children_select already lets
-- them read the links; only this policy was membership only, so `v_board_rides` hid the names a non-member
-- admin saw through `board_rows` (`week_board_rides`). Both reads now agree.
drop policy if exists children_select on public.children;
create policy children_select on public.children for select to authenticated
  using ((select public.is_approved())
         and ((select public.is_admin())
              or department_id in (select d from public.my_department_ids() d(d))));

-- The same for the people added to a ride (`ride_passengers`): the policy let an admin in only inside a department
-- they are a member of, so `v_board_rides.passengers`/`people` lacked them for a non-member admin.
drop policy if exists ride_passengers_select on public.ride_passengers;
create policy ride_passengers_select on public.ride_passengers for select to authenticated
  using ((select public.is_admin())
         or (department_id in (select d from public.my_department_ids() d(d))
             and (public.is_week_public(department_id, week_start)
                  or department_id in (select d from public.my_sadran_department_ids() d(d))
                  or (department_id, week_start) in (select w.department_id, w.week_start
                                                     from public.my_sadran_weeks() w(department_id, week_start))))
         or person_id = (select auth.uid()));
