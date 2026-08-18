-- ============================================================================
-- 0006_rx_attachments.sql — attachments on prescriptions (PHARMACY-ONLY)
-- Pharmacy can attach files (delivery notes, correspondence, scans…) to a
-- prescription while it is in review or after it is dispensed. Files live in
-- a PRIVATE bucket under the prescription's id. Attachments are internal
-- pharmacy working documents: prescribers cannot see them. Every upload is
-- logged to the audit trail. Run AFTER 0005. Safe to re-run.
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

-- Read: pharmacy only — attachments are internal working documents.
drop policy if exists "rx_attach_select" on storage.objects;
create policy "rx_attach_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'rx-attachments'
    and public.is_mfa()
    and public.is_pharmacy()
  );

-- Audit entry for each upload. Logged to account_log (pharmacy-only view),
-- NOT prescription_history, so the owning prescriber sees no trace of these
-- internal documents — not even a filename.
create or replace function public.log_rx_attachment(p_rx_id uuid, p_filename text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text; v_status text; v_ref text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  select status, ref into v_status, v_ref from public.prescriptions where id = p_rx_id;
  if v_status is null then raise exception 'Prescription not found'; end if;
  if v_status not in ('in_review','exported') then
    raise exception 'Attachments can be added only while in review or after dispensing';
  end if;

  v_actor := _actor_name();
  insert into public.account_log(actor, action, detail, kind)
  values (v_actor, 'Attachment added', v_ref || ' — ' || p_filename, 'attachment');
end; $$;

revoke execute on function public.log_rx_attachment(uuid, text) from public, anon;
grant execute on function public.log_rx_attachment(uuid, text) to authenticated;
