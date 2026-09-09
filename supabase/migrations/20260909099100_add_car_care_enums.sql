-- Car care portal: category/kind/tire-state vocabulary. REQ §6 (car care); DATA_MODEL.md §2.
create type public.car_issue_category as enum ('warning_light', 'mechanical', 'lighting', 'physical_damage');
create type public.car_care_kind as enum ('tire_fill', 'wash');
create type public.tire_state as enum ('ok', 'low', 'very_low');
