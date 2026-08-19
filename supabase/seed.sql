-- ============================================================================
-- seed.sql — starter data. Run LAST, after the three migrations.
-- Safe to re-run (idempotent). Real prescriptions/prescribers are created
-- through the app's real flows — this only seeds the pharmacy-controlled
-- formulary (the app needs a drug list) plus a couple of test patients.
-- ============================================================================

insert into public.formulary(name, added_by) values
  ('Hydrocortisone 2.5mg/5ml oral suspension', 'System'),
  ('Omeprazole 2mg/ml oral suspension',        'System'),
  ('Melatonin 1mg/ml oral solution',           'System'),
  ('Diazepam 2mg/5ml oral suspension',         'System'),
  ('Morphine sulfate 10mg/5ml oral solution',  'System'),
  ('Sildenafil 25mg tablets',                  'System'),
  ('Spironolactone 5mg/5ml oral suspension',   'System'),
  ('Propranolol 5mg/5ml oral solution',        'System'),
  ('Baclofen 5mg/5ml oral suspension',         'System'),
  ('Clonidine 25microgram/5ml oral solution',  'System')
on conflict (name) do nothing;

-- Optional test patients (visible to pharmacy immediately; a prescriber only
-- sees a patient once one of their own scripts references them). Remove if you
-- would rather start from an empty patient list.
insert into public.patients(name, dob, gp, allergies)
select * from (values
  ('Alison Reid',    '1979-03-11', 'Riverside Medical Practice', 'Penicillin'),
  ('Marcus Ohene',   '2016-07-02', 'Bellfield Paediatric Clinic', 'NKDA'),
  ('Priya Chandran', '1991-11-24', 'Willowburn Surgery',         'NKDA')
) as v(name, dob, gp, allergies)
where not exists (select 1 from public.patients);
