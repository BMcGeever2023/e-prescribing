# Prescribe — Target Pharmacy

An e-prescribing portal prototype for Target Pharmacy, modelled loosely on
Nymo's Prescribe Portal, Somer Pharmacy's Somerx portal, and signatureRx —
built as a front door for prescribers to submit prescriptions directly,
alongside the existing paper/email intake, with pharmacy-side review before
handoff to the practice PMR.

## Status: real backend (private internal-testing build)

This is now wired to a **real Supabase project** — real Postgres persistence,
database-enforced Row Level Security, real Supabase Auth (hashed passwords,
real sessions, TOTP two-factor auth), no public pharmacy sign-up, and a
private Netlify deployment. The screens/UX are unchanged from the prototype;
what changed is that the data and auth are real.

**Setup and deployment steps live in [`../SETUP.md`](../SETUP.md).** The SQL
that defines the schema, RLS and RPCs lives in [`../supabase/`](../supabase).

Some things remain deliberately simulated for now — see **"What's simulated"**.

## Running it

No build step, no dependencies. First fill in `js/config.js` with your
Supabase URL + anon key (copy `js/config.example.js` → `js/config.js`; see
`../SETUP.md`). Then serve the folder over `http://` (a real origin is
required for Supabase Auth / MFA — `file://` will not work):

```bash
# from this directory
python -m http.server 8000
# then open http://localhost:8000
```

## Project structure

```
prescribe-portal/
├── index.html        # Page shell + all view markup (auth gate, dashboard,
│                      # incoming queue, new prescription form, formulary,
│                      # audit trail, admin screens)
├── css/
│   └── styles.css     # All styling — design tokens live in :root at the top
├── js/
│   └── app.js         # All application logic (state, rendering, auth, signing)
├── assets/
│   └── logo.png        # Target Pharmacy logo
└── README.md
```

Everything currently lives in one `app.js` file (~1,000 lines). It's
organised into clearly commented sections (state/seed data, auth, nav,
dashboard, incoming queue, new prescription + signing, upload/transcribe,
patients, formulary, audit trail, prescriber admin) but hasn't been split
into modules. **Splitting `app.js` into smaller files (e.g. by feature) is a
natural first task for Claude Code**, once you decide whether to keep this
as plain JS or move to a framework.

## Data model & persistence

Data now lives in **Postgres (Supabase)**. `app.js` keeps a small in-memory
`state` object purely as a render cache — `fetchState()` refills it from
Supabase after every change, and every write goes through a `SECURITY DEFINER`
RPC (see `../supabase/migrations/0003_functions.sql`) so access rules, audit
attribution and the signing-PIN check are all enforced server-side. The old
`window.storage` / `seedData()` client persistence has been removed.

The same entities from the prototype are now real tables (`patients`,
`prescriptions`, `prescription_items`, `prescription_history`, `prescribers`,
`staff`, `formulary`, `account_log`):
- `patients` — patient records
- `prescriptions` — every prescription, with `items[]`, `status`, `history[]`
  (the audit trail), and an optional `signature` block
- `prescribers` — prescriber accounts (registration, verification status, PIN)
- `staff` — pharmacy team accounts
- `formulary` — pharmacy-editable list of prescribable drugs
- `accountLog` — audit entries not tied to a specific prescription
- `session` — the currently logged-in user

## Roles

Two account types, with genuinely different nav and permissions in the UI:

- **Prescriber** — registers with professional details, ID upload, and a
  signing PIN. Locked out of prescribing until a pharmacist verifies them.
  Can only submit prescriptions and view their own.
- **Pharmacy** — reviews the incoming queue, uploads paper/email
  prescriptions, manages the formulary, verifies prescriber registrations,
  and has visibility across all patients/prescriptions/audit history.

## What's simulated (read this before demoing externally)

**Authentication is now real** — Supabase Auth with hashed passwords, real
sessions, and TOTP two-factor via an authenticator app. Row Level Security
enforces "a prescriber sees only their own prescriptions; pharmacy sees
everything" in the database. The items below **look** functional but are still
not real:
- **Identity verification** — prescriber "ID documents" are just filenames,
  never actually checked. GMC/NMC/GPhC numbers are never verified against
  a real register.
- **Electronic signatures** — the "advanced electronic signature" is a
  randomly generated ID, not a cryptographically real signature.
- **PMR integration** — "Export to PMR" just changes a status field. There
  is no real PMR connection.
- **OCR** — the paper/email upload flow shows a fake delay and then
  populates a form with one of three canned example values, chosen at
  random. No actual text extraction happens.

## What needs to happen for a production build

Roughly in priority order:

1. **Real backend + database.** Move `state` out of the browser entirely —
   Postgres/similar, an API layer, proper server-side session handling.
2. **Real authentication.** Hashed passwords, real MFA delivery (SMS/email/
   authenticator app), rate limiting, session expiry.
3. **Real identity verification.** A service like Yoti or Onfido for ID
   documents; a real lookup against GMC/NMC/GPhC registers rather than
   trusting whatever the prescriber types in.
4. **Real electronic signatures.** Needs to actually satisfy the Medicines
   for Human Use (Prescribing) Order 2005 requirements for advanced
   electronic signatures — this is a legal/compliance question as much as
   a technical one, worth involving whoever handles regulatory affairs
   before building it for real.
5. **Real PMR integration.** Whatever your existing PMR's API/import format
   supports — this is the part that was explicitly out of scope for the
   prototype (you already have a PMR) but will need a real handoff
   mechanism eventually, even if just a structured export file rather than
   a live API.
6. **Audit trail integrity.** Right now history entries are just array
   entries in client state — for a real GPhC-facing audit trail this needs
   to be append-only and tamper-evident server-side.
7. **Accessibility and cross-browser testing.** Not evaluated yet.

## Design notes

- Color palette and logo were updated mid-project to match Target Pharmacy's
  actual branding (see `:root` custom properties in `styles.css` for the
  red/white/grey palette).
- The "script card" visual (dashed perforated edge, mimicking a tear-off
  prescription pad) is the one deliberate signature UI element — it's used
  consistently for every prescription list across the app.
- Status colors are graded by shade rather than hue where possible (light
  grey → medium grey → dark charcoal for received → in review → exported)
  so the red is reserved for things that actually need attention (query
  raised, urgent, controlled drugs, off-formulary items).
