-- REQ §13.128 (b): a private car a member registered from the profile is that member's to edit on the car page (name,
-- plate, seats) — the car page's editors are the admin, the department's Sadran and the car's responsible person, so a
-- registration now names the owner as the responsible person (`registerTemporaryCar`). Existing private cars with no
-- responsible person get their owner. A loaned car (REQ §13.122 b) keeps its real responsible person.
update public.cars set responsible_id = owner_id
where type = 'temporary' and owner_id is not null and responsible_id is null;
