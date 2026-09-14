-- Coordinates for the seeded demo destinations (REQ §13.83: the "joinable rides" offer
-- needs lat/lng on both destinations; the seeded catalog had none, so the dialog could
-- never fire on demo data). Approximate town centres; a fictional home for נבו near
-- Binyamina/Pardes Hanna, matching the seeded distance_km values. Only fills rows that
-- still have no coordinates, so a hosted project whose admin already set them is untouched.
update public.destinations d
set lat = v.lat, lng = v.lng
from (values
  ('00000000-0000-0000-0000-000000000010', 32.4700, 34.9700),
  ('00000000-0000-0000-0000-000000000011', 32.7940, 34.9896),
  ('00000000-0000-0000-0000-000000000012', 32.5195, 34.9494),
  ('00000000-0000-0000-0000-000000000013', 32.5723, 34.9526),
  ('00000000-0000-0000-0000-000000000014', 32.5183, 34.9046),
  ('00000000-0000-0000-0000-000000000015', 32.0853, 34.7818),
  ('00000000-0000-0000-0000-000000000016', 32.6078, 35.2897),
  ('00000000-0000-0000-0000-000000000017', 32.4740, 34.9676),
  ('00000000-0000-0000-0000-000000000018', 32.3215, 34.8532),
  ('00000000-0000-0000-0000-000000000019', 31.7683, 35.2137)
) as v(id, lat, lng)
where d.id = v.id::uuid and d.lat is null and d.lng is null;
