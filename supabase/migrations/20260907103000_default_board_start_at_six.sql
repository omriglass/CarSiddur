-- Start the visible board at 06:00; the existing early-hours toggle reveals earlier rides.
alter table public.department_settings alter column board_start_time set default time '06:00';
update public.department_settings set board_start_time=time '06:00' where board_start_time=time '05:00';
