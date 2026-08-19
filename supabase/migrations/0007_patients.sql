-- ============================================================================
-- 0007_patients.sql — patient management (add / edit)
-- Prescribers get a Patients page for the patients under their care and can
-- add patients ahead of prescribing; pharmacy can add/edit any patient.
-- A prescriber "cares for" a patient they created or have prescribed to.
-- Run AFTER 0006. Safe to re-run.
-- ============================================================================

-- Who created the patient record (null for legacy/seed rows).
alter table public.patients
  add column if not exists created_by uuid references auth.users(id);

-- Visibility: pharmacy sees all; a prescriber sees patients they created OR
-- patients on one of their own prescriptions. (Previously creation-linked
-- patients were invisible until a prescription existed.)
drop policy if exists patients_select on public.patients;
create policy patients_select on public.patients
  for select to authenticated using (
    is_mfa() and (
      is_pharmacy()
      or created_by = auth.uid()
      or exists (
        select 1 from public.prescriptions p
        where p.patient_id = patients.id and p.prescriber_id = auth.uid()
      )
    )
  );

-- Add (p_id null) or edit (p_id set) a patient. Pharmacy: any patient.
-- Verified prescriber: may add, and may edit only patients under their care.
create or replace function public.upsert_patient(
  p_id uuid, p_name text, p_dob text, p_nhs text, p_gp text, p_allergies text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_actor text; v_id uuid; v_can_edit boolean;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not (is_pharmacy() or is_verified_prescriber()) then
    raise exception 'Only pharmacy staff or verified prescribers can manage patients';
  end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'Patient name is required'; end if;

  v_actor := _actor_name();

  if p_id is null then
    insert into public.patients(name, dob, nhs, gp, allergies, created_by)
    values (btrim(p_name), nullif(p_dob,''), nullif(p_nhs,''), nullif(p_gp,''),
            coalesce(nullif(btrim(p_allergies),''), 'NKDA'), auth.uid())
    returning id into v_id;
    insert into public.account_log(actor, action, detail)
    values (v_actor, 'Patient added', btrim(p_name));
  else
    select is_pharmacy()
        or created_by = auth.uid()
        or exists (select 1 from public.prescriptions p
                   where p.patient_id = p_id and p.prescriber_id = auth.uid())
      into v_can_edit
    from public.patients where id = p_id;
    if v_can_edit is null then raise exception 'Patient not found'; end if;
    if not v_can_edit then raise exception 'This patient is not under your care'; end if;

    update public.patients
       set name = btrim(p_name), dob = nullif(p_dob,''), nhs = nullif(p_nhs,''),
           gp = nullif(p_gp,''), allergies = coalesce(nullif(btrim(p_allergies),''), 'NKDA')
     where id = p_id;
    v_id := p_id;
    insert into public.account_log(actor, action, detail)
    values (v_actor, 'Patient details updated', btrim(p_name));
  end if;

  return v_id;
end; $$;

revoke execute on function public.upsert_patient(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.upsert_patient(uuid, text, text, text, text, text) to authenticated;
