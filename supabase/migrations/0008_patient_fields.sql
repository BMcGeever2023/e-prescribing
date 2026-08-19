-- ============================================================================
-- 0008_patient_fields.sql — retire NHS number; add patient + GP addresses
-- * Wipes NHS numbers from all existing patient records and stops collecting
--   them (the column stays, unused, so nothing referencing it breaks).
-- * Adds patients.address (patient's own address) and patients.gp_address.
-- * upsert_patient gets a new signature with the new fields (old one dropped);
--   create_prescription / create_upload stop writing NHS numbers.
-- Run AFTER 0007. Safe to re-run.
-- ============================================================================

alter table public.patients add column if not exists address text;
alter table public.patients add column if not exists gp_address text;

-- Remove NHS numbers from all records, as requested.
update public.patients set nhs = null where nhs is not null;

-- Old 6-arg version must go so RPC dispatch is unambiguous.
drop function if exists public.upsert_patient(uuid, text, text, text, text, text);

create or replace function public.upsert_patient(
  p_id uuid, p_name text, p_dob text, p_address text,
  p_gp text, p_gp_address text, p_allergies text
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
    insert into public.patients(name, dob, address, gp, gp_address, allergies, created_by)
    values (btrim(p_name), nullif(p_dob,''), nullif(btrim(p_address),''), nullif(btrim(p_gp),''),
            nullif(btrim(p_gp_address),''), coalesce(nullif(btrim(p_allergies),''), 'NKDA'), auth.uid())
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
       set name = btrim(p_name), dob = nullif(p_dob,''), address = nullif(btrim(p_address),''),
           gp = nullif(btrim(p_gp),''), gp_address = nullif(btrim(p_gp_address),''),
           allergies = coalesce(nullif(btrim(p_allergies),''), 'NKDA')
     where id = p_id;
    v_id := p_id;
    insert into public.account_log(actor, action, detail)
    values (v_actor, 'Patient details updated', btrim(p_name));
  end if;

  return v_id;
end; $$;

revoke execute on function public.upsert_patient(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.upsert_patient(uuid, text, text, text, text, text, text) to authenticated;

-- create_prescription: new-patient JSON now carries address/gpAddress, no NHS.
create or replace function public.create_prescription(
  p_patient_id uuid, p_new_patient jsonb, p_items jsonb,
  p_type text, p_urgent boolean, p_notes text, p_pin text
) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_presc   public.prescribers%rowtype;
  v_pid     uuid;
  v_pname   text;
  v_ref     text;
  v_rx      uuid;
  v_sig_id  text;
  v_item    jsonb;
  v_pos     int := 0;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;

  select * into v_presc from public.prescribers where id = auth.uid();
  if v_presc.id is null then raise exception 'Only prescribers can sign prescriptions'; end if;
  if not v_presc.verified then raise exception 'Your account is not yet verified'; end if;
  if v_presc.pin_hash <> crypt(p_pin, v_presc.pin_hash) then
    raise exception 'Incorrect signing PIN';
  end if;

  if p_patient_id is not null then
    select id, name into v_pid, v_pname from public.patients where id = p_patient_id;
    if v_pid is null then raise exception 'Patient not found'; end if;
  else
    insert into public.patients(name, dob, address, gp, gp_address, allergies, created_by)
    values (
      p_new_patient ->> 'name',
      nullif(p_new_patient ->> 'dob',''),
      nullif(p_new_patient ->> 'address',''),
      nullif(p_new_patient ->> 'gp',''),
      nullif(p_new_patient ->> 'gpAddress',''),
      coalesce(nullif(p_new_patient ->> 'allergies',''), 'NKDA'),
      auth.uid())
    returning id, name into v_pid, v_pname;
  end if;

  v_ref    := 'TH-' || to_char(now(),'YYYYMMDD') || '-' ||
              lpad(nextval('public.prescription_ref_seq')::text, 4, '0');
  v_sig_id := 'AES-' || upper(substr(encode(gen_random_bytes(4),'hex'), 1, 8));

  insert into public.prescriptions(
    ref, patient_id, patient_name, prescriber_id, prescriber_name, prescriber_org,
    type, source, urgent, status, notes, signature)
  values (
    v_ref, v_pid, v_pname, v_presc.id, v_presc.name, v_presc.organisation,
    coalesce(p_type,'Private'), 'Portal', coalesce(p_urgent,false), 'received',
    nullif(p_notes,''),
    jsonb_build_object(
      'signatureId', v_sig_id, 'regBody', v_presc.reg_body,
      'regNumber', v_presc.reg_number, 'address', v_presc.address,
      'signedAt', now()))
  returning id into v_rx;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.prescription_items(
      prescription_id, position, drug, form, dose, frequency, quantity, route,
      special, cd, cd_schedule, custom_item)
    values (
      v_rx, v_pos,
      v_item ->> 'drug', nullif(v_item ->> 'form',''), v_item ->> 'dose',
      v_item ->> 'frequency', v_item ->> 'quantity', v_item ->> 'route',
      coalesce((v_item ->> 'special')::boolean, false),
      coalesce((v_item ->> 'cd')::boolean, false),
      nullif(v_item ->> 'cdSchedule',''),
      coalesce((v_item ->> 'customItem')::boolean, false));
    v_pos := v_pos + 1;
  end loop;

  insert into public.prescription_history(prescription_id, actor, action, detail)
  values (v_rx, v_presc.name, 'Submitted & signed',
          'Advanced electronic signature applied (' || v_sig_id || ').');

  return v_ref;
end; $$;

-- create_upload: stop writing the retired NHS column.
create or replace function public.create_upload(
  p_patient_name text, p_dob text, p_prescriber_name text, p_org text,
  p_drug text, p_notes text, p_source text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_actor text; v_pid uuid; v_ref text; v_rx uuid; v_src text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  v_actor := _actor_name();
  v_src   := coalesce(nullif(p_source,''), 'Paper Upload');

  select id into v_pid from public.patients where lower(name) = lower(p_patient_name) limit 1;
  if v_pid is null then
    insert into public.patients(name, dob, gp, allergies)
    values (p_patient_name, nullif(p_dob,''), nullif(p_org,''), 'NKDA')
    returning id into v_pid;
  end if;

  v_ref := 'TH-' || to_char(now(),'YYYYMMDD') || '-' ||
           lpad(nextval('public.prescription_ref_seq')::text, 4, '0');

  insert into public.prescriptions(
    ref, patient_id, patient_name, prescriber_id, prescriber_name, prescriber_org,
    type, source, urgent, status, notes, signature)
  values (
    v_ref, v_pid, p_patient_name, null, p_prescriber_name, nullif(p_org,''),
    'Private', v_src, false, 'received', nullif(p_notes,''), null)
  returning id into v_rx;

  insert into public.prescription_items(prescription_id, position, drug, form, route)
  values (v_rx, 0, p_drug, 'Other', 'Oral');

  insert into public.prescription_history(prescription_id, actor, action, detail)
  values (v_rx, v_actor, 'Received', 'Transcribed from ' || lower(v_src) || '.');

  return v_ref;
end; $$;
