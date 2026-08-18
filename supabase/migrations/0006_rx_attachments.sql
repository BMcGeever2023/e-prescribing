-- ============================================================================
-- 0006_rx_attachments.sql — attachments on prescriptions
-- Pharmacy can attach files (delivery notes, correspondence, scans…) to a
-- prescription while it is in review or after it is dispensed. Files live in
-- a PRIVATE bucket under the prescription's id; the prescription's own
-- prescriber can view them; every upload is logged to the audit trail.
-- Run AFTER 0005.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rx-attachments', 'rx-attachments', false, 10485760,
        array['image/png','image/jpeg','image/jpg','application/pdf'])
on conflict (id) do nothing;

-- Upload: pharmacy only, MFA'd, and only while the prescription is in review
-- or dispensed. Objects live under  rx-attachments/{prescription_id}/{file}.
drop policy if exists "rx_attach_insert_pharmacy" on storage.objects;
create policy "rx_attach_insert_pharmacy" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'rx-attachments'
    and public.is_mfa()
    and public.is_pharmacy()
    and exists (
      select 1 from public.prescriptions p
      where p.id::text = (storage.foldername(name))[1]
        and p.status in ('in_review','exported')
    )
  );

-- Read: pharmacy, or the prescriber who owns the prescription.
drop policy if exists "rx_attach_select" on storage.objects;
create policy "rx_attach_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'rx-attachments'
    and public.is_mfa()
    and (
      public.is_pharmacy()
      or exists (
        select 1 from public.prescriptions p
        where p.id::text = (storage.foldername(name))[1]
          and p.prescriber_id = auth.uid()
      )
    )
  );

-- Audit-trail entry for each upload (writes to history go through RPCs only).
create or replace function public.log_rx_attachment(p_rx_id uuid, p_filename text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text; v_status text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  select status into v_status from public.prescriptions where id = p_rx_id;
  if v_status is null then raise exception 'Prescription not found'; end if;
  if v_status not in ('in_review','exported') then
    raise exception 'Attachments can be added only while in review or after dispensing';
  end if;

  v_actor := _actor_name();
  update public.prescriptions set updated_at = now() where id = p_rx_id;
  insert into public.prescription_history(prescription_id, actor, action, detail)
  values (p_rx_id, v_actor, 'Attachment added', p_filename);
end; $$;

revoke execute on function public.log_rx_attachment(uuid, text) from public, anon;
grant execute on function public.log_rx_attachment(uuid, text) to authenticated;
