-- ============================================================================
-- 0002_rls.sql — Row Level Security
-- The access rules the prototype only faked in the UI, enforced in the DB.
--   * a prescriber can only ever see their OWN prescriptions/patients
--   * pharmacy accounts can see everything
--   * MFA (aal2) is required to read clinical data
-- Run AFTER 0001_schema.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper predicates.
-- SECURITY DEFINER so they bypass RLS on staff/prescribers (avoids the
-- policy-recursion trap) while still reading the *caller's* auth.uid().
-- ---------------------------------------------------------------------------
create or replace function public.is_pharmacy()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where id = auth.uid());
$$;

create or replace function public.is_verified_prescriber()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.prescribers where id = auth.uid() and verified);
$$;

-- True only once the session has cleared the second factor (TOTP).
create or replace function public.is_mfa()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

-- ---------------------------------------------------------------------------
-- Base privileges. RLS still gates every row; these just let the
-- `authenticated` role attempt SELECTs. `anon` gets nothing.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on
  public.staff, public.prescribers, public.patients, public.formulary,
  public.prescriptions, public.prescription_items, public.prescription_history,
  public.account_log
to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. With RLS on and only SELECT policies below, all
-- INSERT/UPDATE/DELETE from clients is blocked — every write goes through the
-- SECURITY DEFINER RPCs in 0003_functions.sql instead.
-- ---------------------------------------------------------------------------
alter table public.staff                  enable row level security;
alter table public.prescribers            enable row level security;
alter table public.patients               enable row level security;
alter table public.formulary              enable row level security;
alter table public.prescriptions          enable row level security;
alter table public.prescription_items     enable row level security;
alter table public.prescription_history   enable row level security;
alter table public.account_log            enable row level security;

-- staff — visible to pharmacy only. No write policy => service_role only.
drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff
  for select to authenticated using (is_pharmacy());

-- prescribers — a prescriber sees only their own row; pharmacy sees all.
drop policy if exists prescribers_select on public.prescribers;
create policy prescribers_select on public.prescribers
  for select to authenticated using (is_pharmacy() or id = auth.uid());

-- patients — pharmacy sees all; a prescriber sees only patients attached to
-- one of their own prescriptions. Requires MFA.
drop policy if exists patients_select on public.patients;
create policy patients_select on public.patients
  for select to authenticated using (
    is_mfa() and (
      is_pharmacy()
      or exists (
        select 1 from public.prescriptions p
        where p.patient_id = patients.id and p.prescriber_id = auth.uid()
      )
    )
  );

-- formulary — every authenticated user can read the drug list (prescribers
-- need it to write scripts). Writes are pharmacy-only RPCs.
drop policy if exists formulary_select on public.formulary;
create policy formulary_select on public.formulary
  for select to authenticated using (true);

-- prescriptions — the core rule: own-or-pharmacy, and only with MFA.
drop policy if exists prescriptions_select on public.prescriptions;
create policy prescriptions_select on public.prescriptions
  for select to authenticated using (
    is_mfa() and (is_pharmacy() or prescriber_id = auth.uid())
  );

-- items + history — visible iff the parent prescription is visible.
drop policy if exists items_select on public.prescription_items;
create policy items_select on public.prescription_items
  for select to authenticated using (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_id
        and is_mfa()
        and (is_pharmacy() or p.prescriber_id = auth.uid())
    )
  );

drop policy if exists history_select on public.prescription_history;
create policy history_select on public.prescription_history
  for select to authenticated using (
    exists (
      select 1 from public.prescriptions p
      where p.id = prescription_id
        and is_mfa()
        and (is_pharmacy() or p.prescriber_id = auth.uid())
    )
  );
-- NB: prescription_history has NO update/delete policy, ever → append-only.

-- account_log — pharmacy audit view only.
drop policy if exists account_log_select on public.account_log;
create policy account_log_select on public.account_log
  for select to authenticated using (is_mfa() and is_pharmacy());
