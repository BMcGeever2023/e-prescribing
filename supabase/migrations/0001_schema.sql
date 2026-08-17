-- ============================================================================
-- 0001_schema.sql — Prescribe Portal schema
-- Normalises the client-side `state` object (see prescribe-portal/README.md)
-- into real Postgres tables. Run this FIRST in the Supabase SQL editor.
-- ----------------------------------------------------------------------------
-- Ordering: 0001_schema  ->  0002_rls  ->  0003_functions  ->  seed.sql
-- ============================================================================

-- pgcrypto gives us crypt()/gen_salt() (signing-PIN hashing) and
-- gen_random_bytes() (signature ids). On Supabase, extensions live in the
-- dedicated `extensions` schema, so we install it there and the functions that
-- use it set `search_path = public, extensions` (see 0003_functions.sql).
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Accounts
-- Both profile tables are keyed by auth.users.id, so a Supabase Auth user
-- IS the account. A logged-in user with no row in either table has no data
-- access at all (see 0002_rls.sql).
-- ---------------------------------------------------------------------------

-- Pharmacy team. Rows here are only ever created with the service_role key
-- (Supabase dashboard / SETUP.md) — there is no client path to create one,
-- which is what keeps pharmacy sign-up non-self-service.
create table if not exists public.staff (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  title      text not null,
  email      text not null,
  created_at timestamptz not null default now()
);

-- Prescribers. Created by self-registration but start unverified and cannot
-- prescribe until a pharmacist verifies them.
create table if not exists public.prescribers (
  id           uuid primary key references auth.users(id) on delete cascade,
  name         text not null,
  prof_role    text not null,
  reg_body     text not null,
  reg_number   text not null,
  organisation text not null,
  address      text not null,
  email        text not null,
  pin_hash     text not null,            -- bcrypt hash of the 4-digit signing PIN
  id_doc       text,                     -- filename only (real ID verification is future work)
  indemnity    boolean not null default false,
  verified     boolean not null default false,
  verified_by  text,
  verified_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Clinical data
-- ---------------------------------------------------------------------------
create table if not exists public.patients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  dob        text,
  nhs        text,
  gp         text,
  allergies  text,
  created_at timestamptz not null default now()
);

create table if not exists public.formulary (
  id       uuid primary key default gen_random_uuid(),
  name     text not null unique,
  added_by text not null,
  added_at timestamptz not null default now()
);

-- Human-friendly prescription reference (TH-YYYYMMDD-0001) counter.
create sequence if not exists public.prescription_ref_seq start 1;

create table if not exists public.prescriptions (
  id             uuid primary key default gen_random_uuid(),
  ref            text not null unique,
  patient_id     uuid references public.patients(id),
  patient_name   text not null,
  prescriber_id  uuid references public.prescribers(id),   -- NULL for paper/email uploads
  prescriber_name text not null,
  prescriber_org text,
  type           text not null default 'Private',
  source         text not null,
  urgent         boolean not null default false,
  status         text not null default 'received'
                 check (status in ('received','in_review','query','exported','rejected')),
  notes          text,
  -- Signature is stored as jsonb with the exact shape the UI already expects:
  -- { signatureId, regBody, regNumber, address, signedAt }
  signature      jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists prescriptions_prescriber_idx on public.prescriptions(prescriber_id);
create index if not exists prescriptions_status_idx      on public.prescriptions(status);

create table if not exists public.prescription_items (
  id              uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  position        int not null default 0,
  drug            text not null,
  form            text,
  dose            text,
  frequency       text,
  quantity        text,
  route           text,
  special         boolean not null default false,
  cd              boolean not null default false,
  cd_schedule     text,
  custom_item     boolean not null default false
);
create index if not exists prescription_items_rx_idx on public.prescription_items(prescription_id);

-- Append-only audit trail per prescription (no UPDATE/DELETE policy — see 0002).
create table if not exists public.prescription_history (
  id              uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  ts              timestamptz not null default now(),
  actor           text not null,
  action          text not null,
  detail          text
);
create index if not exists prescription_history_rx_idx on public.prescription_history(prescription_id);

-- Append-only account/formulary/verification audit not tied to one prescription.
create table if not exists public.account_log (
  id     uuid primary key default gen_random_uuid(),
  ts     timestamptz not null default now(),
  actor  text not null,
  action text not null,
  detail text,
  kind   text
);
