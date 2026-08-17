-- ============================================================================
-- 0003_functions.sql — RPCs (all SECURITY DEFINER)
-- Every state change goes through one of these so we get: server-derived
-- actor names, atomic multi-table writes, append-only history, server-side
-- signing-PIN verification, and MFA enforcement — none of which the client
-- can bypass. Run AFTER 0002_rls.sql.
-- ============================================================================

-- Resolve the display name of the current user (pharmacy or prescriber).
create or replace function public._actor_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select name from public.staff       where id = auth.uid()),
    (select name from public.prescribers where id = auth.uid()),
    'System');
$$;

-- ---------------------------------------------------------------------------
-- Prescriber self-registration (called right after auth.signUp, at aal1 —
-- so this one does NOT require MFA; the user enrols TOTP straight after).
-- ---------------------------------------------------------------------------
create or replace function public.complete_prescriber_registration(
  p_name text, p_prof_role text, p_reg_body text, p_reg_number text,
  p_organisation text, p_address text, p_email text, p_pin text,
  p_id_doc text default null, p_indemnity boolean default false
) returns void
-- includes `extensions` so pgcrypto's crypt()/gen_salt() resolve on Supabase
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'Signing PIN must be exactly 4 digits'; end if;
  -- A pharmacy user must never be able to turn themselves into a prescriber.
  if exists (select 1 from public.staff where id = auth.uid()) then
    raise exception 'This account already exists as a pharmacy account';
  end if;

  insert into public.prescribers(
    id, name, prof_role, reg_body, reg_number, organisation, address, email,
    pin_hash, id_doc, indemnity, verified)
  values (
    auth.uid(), p_name, p_prof_role, p_reg_body, p_reg_number, p_organisation,
    p_address, p_email, crypt(p_pin, gen_salt('bf')), p_id_doc, coalesce(p_indemnity,false), false)
  on conflict (id) do nothing;

  insert into public.account_log(actor, action, detail)
  values (p_name, 'Registered', p_name || ' submitted registration for verification.');
end; $$;

-- ---------------------------------------------------------------------------
-- Sign & send a prescription. This is the real electronic-signing step:
-- the caller must be a VERIFIED prescriber, MFA'd, and supply the correct
-- signing PIN (checked against the bcrypt hash here — never on the client).
-- ---------------------------------------------------------------------------
create or replace function public.create_prescription(
  p_patient_id uuid, p_new_patient jsonb, p_items jsonb,
  p_type text, p_urgent boolean, p_notes text, p_pin text
) returns text
-- includes `extensions` so pgcrypto's crypt()/gen_random_bytes() resolve on Supabase
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
    insert into public.patients(name, dob, nhs, gp, allergies)
    values (
      p_new_patient ->> 'name',
      nullif(p_new_patient ->> 'dob',''),
      nullif(p_new_patient ->> 'nhs',''),
      nullif(p_new_patient ->> 'gp',''),
      coalesce(nullif(p_new_patient ->> 'allergies',''), 'NKDA'))
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

-- ---------------------------------------------------------------------------
-- Pharmacy: log a paper/emailed prescription into the queue.
-- ---------------------------------------------------------------------------
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
    insert into public.patients(name, dob, nhs, gp, allergies)
    values (p_patient_name, nullif(p_dob,''), '', nullif(p_org,''), 'NKDA')
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

-- ---------------------------------------------------------------------------
-- Pharmacy: move a prescription through its lifecycle.
-- ---------------------------------------------------------------------------
create or replace function public.update_prescription_status(
  p_rx_id uuid, p_status text, p_detail text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text; v_action text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  if p_status not in ('in_review','query','exported','rejected') then
    raise exception 'Invalid status';
  end if;
  if not exists (select 1 from public.prescriptions where id = p_rx_id) then
    raise exception 'Prescription not found';
  end if;

  v_actor  := _actor_name();
  v_action := case p_status
                when 'in_review' then 'Review started'
                when 'query'     then 'Query raised'
                when 'exported'  then 'Exported to PMR'
                when 'rejected'  then 'Rejected' end;

  update public.prescriptions set status = p_status, updated_at = now() where id = p_rx_id;
  insert into public.prescription_history(prescription_id, actor, action, detail)
  values (p_rx_id, v_actor, v_action, nullif(p_detail,''));
end; $$;

-- ---------------------------------------------------------------------------
-- Prescriber: reply to a pharmacy query on their OWN prescription.
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_query(p_rx_id uuid, p_reply text)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_owner uuid;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  select prescriber_id into v_owner from public.prescriptions where id = p_rx_id;
  if v_owner is null then raise exception 'Prescription not found'; end if;
  if v_owner <> auth.uid() then raise exception 'Not your prescription'; end if;

  select name into v_name from public.prescribers where id = auth.uid();
  update public.prescriptions set status = 'in_review', updated_at = now() where id = p_rx_id;
  insert into public.prescription_history(prescription_id, actor, action, detail)
  values (p_rx_id, v_name, 'Prescriber responded', nullif(p_reply,''));
end; $$;

-- ---------------------------------------------------------------------------
-- Pharmacy: verify / reject a prescriber registration.
-- ---------------------------------------------------------------------------
create or replace function public.verify_prescriber(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_actor text; v_p public.prescribers%rowtype;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  select * into v_p from public.prescribers where id = p_id;
  if v_p.id is null then raise exception 'Prescriber not found'; end if;

  v_actor := _actor_name();
  update public.prescribers
     set verified = true, verified_by = v_actor, verified_at = now()
   where id = p_id;
  insert into public.account_log(actor, action, detail)
  values (v_actor, 'Verified',
          v_p.reg_body || ' ' || v_p.reg_number || ' checked and confirmed for '
          || v_p.name || '. Prescriber account activated.');
end; $$;

create or replace function public.reject_prescriber(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_actor text; v_p public.prescribers%rowtype;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  select * into v_p from public.prescribers where id = p_id;
  if v_p.id is null then raise exception 'Prescriber not found'; end if;

  v_actor := _actor_name();
  insert into public.account_log(actor, action, detail)
  values (v_actor, 'Registration rejected',
          v_p.name || ' (' || v_p.reg_body || ' ' || v_p.reg_number || ') — '
          || coalesce(nullif(p_reason,''), 'no reason given') || '.');
  -- Removes the profile; the underlying auth.users row can be deleted from the
  -- dashboard if you want to free the email address (see SETUP.md).
  delete from public.prescribers where id = p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Pharmacy: formulary management.
-- ---------------------------------------------------------------------------
create or replace function public.add_formulary_item(p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  v_actor := _actor_name();
  insert into public.formulary(name, added_by) values (p_name, v_actor);
  insert into public.account_log(actor, action, detail, kind)
  values (v_actor, 'Formulary item added', p_name, 'formulary');
end; $$;

create or replace function public.edit_formulary_item(p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_actor text; v_old text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  select name into v_old from public.formulary where id = p_id;
  if v_old is null then raise exception 'Formulary item not found'; end if;
  v_actor := _actor_name();
  update public.formulary set name = p_name where id = p_id;
  insert into public.account_log(actor, action, detail, kind)
  values (v_actor, 'Formulary item edited', '"' || v_old || '" → "' || p_name || '"', 'formulary');
end; $$;

create or replace function public.remove_formulary_item(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_actor text; v_name text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  select name into v_name from public.formulary where id = p_id;
  if v_name is null then raise exception 'Formulary item not found'; end if;
  v_actor := _actor_name();
  delete from public.formulary where id = p_id;
  insert into public.account_log(actor, action, detail, kind)
  values (v_actor, 'Formulary item removed', v_name, 'formulary');
end; $$;

-- ---------------------------------------------------------------------------
-- Execute privileges: RPCs are for logged-in users only (they each re-check
-- role + MFA internally). anon cannot call them.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
