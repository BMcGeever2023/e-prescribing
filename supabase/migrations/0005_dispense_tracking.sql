-- ============================================================================
-- 0005_dispense_tracking.sql — "Dispensed" wording + tracking details
-- 1) The pharmacy action formerly labelled "Exported to PMR" is now
--    "Dispensed" (the internal status key stays `exported`; only the
--    user-facing audit label changes — old history rows keep their original
--    wording, as an append-only audit trail should).
-- 2) New RPC add_tracking_details: after a prescription is dispensed, the
--    pharmacy can append tracking details (courier, tracking number, ETA)
--    to its audit history.
-- Run AFTER 0004 (or after 0003 on an install without storage).
-- ============================================================================

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
                when 'exported'  then 'Dispensed'
                when 'rejected'  then 'Rejected' end;

  update public.prescriptions set status = p_status, updated_at = now() where id = p_rx_id;
  insert into public.prescription_history(prescription_id, actor, action, detail)
  values (p_rx_id, v_actor, v_action, nullif(p_detail,''));
end; $$;

create or replace function public.add_tracking_details(p_rx_id uuid, p_detail text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_actor text; v_status text;
begin
  if not is_mfa() then raise exception 'Two-factor authentication required'; end if;
  if not is_pharmacy() then raise exception 'Pharmacy accounts only'; end if;
  if p_detail is null or btrim(p_detail) = '' then raise exception 'Enter the tracking details'; end if;
  select status into v_status from public.prescriptions where id = p_rx_id;
  if v_status is null then raise exception 'Prescription not found'; end if;
  if v_status <> 'exported' then
    raise exception 'Tracking details can only be added once a prescription is dispensed';
  end if;

  v_actor := _actor_name();
  update public.prescriptions set updated_at = now() where id = p_rx_id;
  insert into public.prescription_history(prescription_id, actor, action, detail)
  values (p_rx_id, v_actor, 'Tracking details added', btrim(p_detail));
end; $$;

-- New function: lock down execute the same way 0003 did for the others.
revoke execute on function public.add_tracking_details(uuid, text) from public, anon;
grant execute on function public.add_tracking_details(uuid, text) to authenticated;
