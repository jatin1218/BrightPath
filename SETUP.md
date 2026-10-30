# Brightpath v9 setup — Supabase + Vercel

## 1. Create the database tables

Open your **budxsuovluwzqpizyqsk** Supabase project → **SQL Editor** → **New query**. Copy the entire contents of **sql/001_supabase_multicenter.sql** and click **Run** as the project database owner (`postgres`).

The SQL creates a private schema with center-scoped tables, a restricted backend role, RLS policies and a center-code lookup function. It is safe to run again. It does not remove or replace existing public/auth tables. Do not add `brightpath_private` to the schemas exposed by the Data API. Use Table Editor's schema selector to inspect it as the owner.

## 2. Configure the server privately

Copy **.env.example** to **.env** for local use. The provided Supabase project URL and publishable key are already filled in. Replace `[YOUR-PASSWORD]` inside `DATABASE_URL` with your actual Supabase **database password**. This is not your Supabase account password and not the publishable key. Percent-encode special characters in the password. Verify the pooler host/port in Supabase's **Connect → Transaction pooler** panel; the bundled host is the one you supplied.

Never paste the password in chat, commit .env, put it in browser code, or prefix DATABASE_URL with VITE_. TLS verification is enabled. If your connection requires the Supabase CA certificate, set DATABASE_CA_CERT to its trusted PEM; do not set rejectUnauthorized=false.

This edition connects directly to PostgreSQL through the backend. The supplied SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are recorded as project configuration but are not sufficient to connect to the private tables. Supabase Auth is not used. No secret/service-role API key is required. DIRECT_URL is reserved for optional manual migration tools and is not required for website requests.

## 3. Run locally

Use Node.js 24, then in the extracted project directory:

```powershell
Copy-Item .env.example .env
# Edit .env privately and fill DATABASE_URL before continuing.
npm install
npm run db:check
npm run build
npm start
```

Open **http://localhost:3000**. `db:check` must report that the database, schema and backend role are ready. This verifies the connection without creating an account. Local and deployed cookies are separate.

## 4. Multiple coordinators and learning centers

**Coordinator opening a separate center:** Create an account → Coordinator → **Create my learning center** → enter center name, full name, email and password. Save the recovery key AND center code shown after signup. Another coordinator can independently repeat this process; their records will be separate. The same email may exist in different centers; login uses the center code to distinguish accounts.

**Coordinator joining an existing center:** An active coordinator of that center creates an invitation in the staff/coordinator section for the exact email and Coordinator role. Recipient chooses **Join an existing center**, enters the center code and invitation, and sets their own password. These coordinators share that center's administration.

**Educators:** Coordinator creates an Educator invitation. Educator registers with the center code, exact invited email and invitation code. Coordinator assigns one or more courses.

**Learners:** Register with the center code. The account is pending until that center's coordinator approves it and enrolls it in courses. Learners cannot promote themselves or view staff administration.

The center code is a routing/join identifier, not an administrator password. Staff invitations expire after 24 hours and are single-use. Roles are verified by the server, not trusted from the login dropdown. Recovery uses the saved recovery key; no email or OTP is sent. Enable authenticator MFA through Account security if needed.

## 5. Publish the updated project to Vercel

This code does not automatically change the existing live website or database. Complete SQL setup and the private environment variable first.

In Vercel, open the existing **brightpath-cloud-json** project → Settings → Environment Variables. Set **Production**:

```text
BRIGHTPATH_STORAGE=postgres
DATABASE_URL=<your actual transaction-pooler URL with password>
SUPABASE_URL=https://budxsuovluwzqpizyqsk.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_jy_0o0Gb9j_e5_MsD3ycrA_DmnYU_QX
```

Mark DATABASE_URL Sensitive. Do not use production database credentials for untrusted Preview deployments. Keep old Blob data/credentials until migration is verified; PostgreSQL mode ignores them. Remove any BRIGHTPATH_ADMIN_EMAIL or BRIGHTPATH_ADMIN_PASSWORD seed variables. Do not reuse an old BRIGHTPATH_STORAGE=blob/json value.

Deploy this UPDATED source, not merely Redeploy on the old Vercel build:

```powershell
npx vercel@63.1.2 login
npx vercel@63.1.2 link
# Select the existing brightpath-cloud-json project.
npx vercel@63.1.2 --prod
```

The supplied vercel.json builds Vite and routes `/api/*` to the Node backend. A Git repository connected to the same project is another deployment option. Vercel Drop creates a new project; it does not update this project's source.

Verify `/api/health` returns `ok: true`, `storage: "postgres"`, `multiCenter: true`. Create your own center, sign out/in with its code, and verify a saved course after refresh. Authenticated workflows were tested locally with PostgreSQL/WASM; your live Supabase/Vercel connection cannot be verified until SQL and real credentials are configured.

## 6. Preserve existing records before switching

Nothing is automatically copied from the old Blob database. For a fresh start, use registration. To keep existing accounts and academic history:

1. Pause writes to the old deployment during the final backup/cutover. Keep it and the Blob file for rollback.
2. Obtain a private JSON backup from the old Blob store, either via the Vercel owner dashboard download or `npm run storage:backup -- old-backup.json` using the old private Blob credentials in `.env.cloud`. Do not send the backup in chat; it contains account and session data.
3. Configure `.env` for the new database and run:

```powershell
npm run db:import -- old-backup.json "Your learning center name"
```

The importer creates a NEW center, prints its center code, preserves users/password hashes/recovery keys/MFA/courses/attendance/materials and clears sessions to require fresh sign-in. It never replaces an existing center. Do not run it repeatedly unless you intentionally want separate copies. An active coordinator must be present in the backup.

4. Sign in with the printed code and an existing account password, verify records, then allow users onto the updated site. New centers can still register independently.

Backup one database center later:

```powershell
npm run db:backup -- YOUR12CHARCD backups/my-center-2026-10-28.json
```

Create the backups directory first. The tool refuses to overwrite an existing file. Protect backups like credentials. For disaster recovery, import into a new center and verify before changing user access; do not erase existing centers.

## Operational limits

The database uses a row per application record with JSONB contents. To preserve existing logic, each request loads and serializes one center's state under a transaction lock. Different centers are independent. Within a center, long requests may wait; a lock timeout returns a retryable error without claiming success. Uploads remain capped at 4 MiB per file on Vercel, with 64 MiB total stored attachments per center; large lecture recordings should use HTTPS links. Built-in automatic video recording is not included.

No billing, SMS, email delivery, automatic backups, or production load-test certification is implied by this setup. Enable appropriate provider backups and monitor your project's usage for real operation.
