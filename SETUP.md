# Setup — real backend, real auth, private hosting

This turns the prototype into a private internal-testing tool backed by a real
Supabase project (Postgres + Row Level Security + Auth + TOTP MFA), run locally
against that project and deployed privately to Netlify.

Everything in the repo is done. The steps below are the parts that need **your**
Supabase and Netlify accounts. Work top to bottom.

> **Two keys, know the difference.** Your project has an **anon** ("public")
> key and a **service_role** ("secret") key. The anon key is meant to live in
> the browser — Row Level Security is what protects the data. The service_role
> key bypasses all security: keep it in the Supabase dashboard only, never in
> this repo, never in the front-end, never in chat.

---

## 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Pick an organisation, name it (e.g. `prescribe-portal`), set a strong
   database password (save it in your password manager), choose a region close
   to you (e.g. London / `eu-west-2`). Create it and wait for provisioning.

## 2. Create the schema

1. In the project, open **SQL Editor** → **New query**.
2. Run these files **in order** (open each file in the repo, copy all of
   it, paste, **Run**):
   1. `supabase/migrations/0001_schema.sql`
   2. `supabase/migrations/0002_rls.sql`
   3. `supabase/migrations/0003_functions.sql`
   4. `supabase/migrations/0004_storage.sql`  ← private bucket for prescriber ID documents
   5. `supabase/migrations/0005_dispense_tracking.sql`  ← "Dispensed" wording + tracking-details RPC
   6. `supabase/migrations/0006_rx_attachments.sql`  ← private bucket for prescription attachments
   7. `supabase/migrations/0007_patients.sql`  ← patient add/edit + prescriber Patients page
   8. `supabase/seed.sql`
3. Each should report success. After this you have all tables, RLS policies,
   RPCs, the private `prescriber-ids` storage bucket, the formulary, and a few
   test patients.

## 3. Auth settings

Open **Authentication** in the dashboard.

- **Email confirmation** — for a closed internal test group, turn this **off**
  so registration completes in one step: **Authentication → Sign In / Providers
  → Email → turn off "Confirm email"** (label may read "Enable email
  confirmations"). *(If you leave it on, a registered prescriber must click the
  email link before their first login; the app tells them so.)*
- **MFA (TOTP)** — authenticator-app MFA is available by default; there's
  nothing to switch on. You can confirm under **Authentication → Multi-Factor
  Authentication** that TOTP is allowed.
- **URL configuration** — **Authentication → URL Configuration**:
  - **Site URL**: your Netlify URL once you have it (step 7), e.g.
    `https://prescribe-portal.netlify.app`.
  - **Redirect URLs**: add `http://localhost:8000` (local dev) and your Netlify
    URL. *(These matter mainly if you re-enable email confirmation.)*

## 4. Create your pharmacy account(s)

Pharmacy accounts are **not** self-service — you create them here.

1. **Authentication → Users → Add user → Create new user.** Enter the
   pharmacist's email + a temporary password, tick **Auto Confirm User**, create.
2. Open **SQL Editor** and run this, editing the email/name/title (the email
   must match the user you just created):

   ```sql
   insert into public.staff (id, name, title, email)
   select id, 'J. Ferris', 'Superintendent Pharmacist', email
   from auth.users
   where email = 'j.ferris@target-healthcare.co.uk'
   on conflict (id) do nothing;
   ```

3. Repeat for any other pharmacist. On that account's **first login** the app
   walks them through scanning a QR code to set up their authenticator.

## 5. Point the app at your project

1. Get your keys: **Project Settings → API**. Copy the **Project URL** and the
   **anon public** key.
2. In the repo, open `prescribe-portal/js/config.js` (it already exists and is
   gitignored) and paste both values in:

   ```js
   window.PORTAL_CONFIG = {
     SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi...your anon key...'
   };
   ```

## 6. Run it locally against the real project

This machine has no Python or Node, so use the bundled zero-install server.
From the repo root:

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Open <http://localhost:8000>. (Uses the real Supabase project — the anon key is
safe in the browser; RLS enforces access.) `serve.ps1` needs a real origin,
which it provides; opening `index.html` via `file://` will not work with
Supabase Auth. *(If you later install Python or Node, `python -m http.server
8000` from `prescribe-portal/` or `npx serve prescribe-portal` also work.)*

### End-to-end smoke test
1. **Register** as a prescriber (Register tab) → after submitting, you're on the
   login screen. Log in → **scan the QR** with an authenticator app → enter the
   code. You should land on the dashboard as **pending verification**, and
   **New prescription** should be locked.
2. Log in as your **pharmacy** account (separate browser/incognito) → **Prescriber
   accounts** → **Verify** the prescriber.
3. Back as the prescriber (re-login), **New prescription** → fill it in →
   **Continue to sign** → enter your 4-digit PIN → it appears in the pharmacy
   **Incoming** queue.
4. **RLS proof**: register a *second* prescriber and sign a script. Confirm each
   prescriber sees only their own scripts, and the pharmacy sees all. (You can
   even open the browser console as a prescriber and run a raw
   `await window.__nope` — there's no client bypass; a direct
   `supabase.from('prescriptions').select('*')` still returns only their rows.)

## 7. Private hosting on Netlify (two layers)

The app has its own login; Netlify adds a **second** shared password in front of
the whole deployment.

1. In Netlify: **Add new site → Import an existing project**, pick the GitHub
   repo (`e-prescribing`).
2. Build settings: leave everything as detected — `netlify.toml` already sets
   the publish directory, the no-index headers, and a build command that writes
   `js/config.js` from environment variables at deploy time.
3. **Set the environment variables** (before the first deploy, or redeploy
   after): **Site configuration → Environment variables → Add a variable**:
   - `SUPABASE_URL` = `https://YOUR-PROJECT-REF.supabase.co`
   - `SUPABASE_ANON_KEY` = your **anon/public** key (never service_role)
   The build fails with a clear error if either is missing.
4. **Second password layer**: currently **skipped** (decided during setup —
   the app's own login + MFA + RLS is the protection; the site is noindexed).
   To add it later, either upgrade to Netlify **Pro** and use **Site
   configuration → Access & security → Password protection**, or ask Claude to
   add the free edge-function basic-auth layer.
5. Set the Supabase **Site URL / Redirect URLs** (step 3) to the Netlify URL.
6. Verify: the site loads the app login; `https://YOUR-SITE/robots.txt` returns
   `Disallow: /`; responses carry `X-Robots-Tag: noindex`.

## 8. Push to GitHub

The repo is already initialised with an initial commit. To publish it privately:

```bash
gh repo create prescribe-portal --private --source . --push
```

(or create a private repo in the GitHub UI and `git remote add origin … && git push -u origin main`).

---

## Operating notes
- **Rejecting a prescriber** removes their profile but leaves the underlying
  auth user. To free the email address, delete the user under **Authentication →
  Users**.
- **Forgotten signing PIN**: there's no self-serve reset yet. As admin you can
  reset it in SQL:
  `update public.prescribers set pin_hash = crypt('1234', gen_salt('bf')) where email = '…';`
- **Still simulated** (unchanged from the prototype, and out of scope for this
  pass): real GMC/NMC/GPhC register lookups, legally-compliant advanced
  electronic signatures, real PMR integration, and OCR of uploads. See the
  prototype README for the full list.
- **Backups**: Supabase takes automatic backups on paid plans; on the free plan,
  export periodically if the test data matters.
