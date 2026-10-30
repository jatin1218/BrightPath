# Brightpath v9 — Supabase PostgreSQL, independent learning centers

Read **SETUP.md** first. The complete, repeatable Supabase SQL is **sql/001_supabase_multicenter.sql**.

- Every coordinator can create a new center with their own email/password. There is no fixed coordinator email or global first-coordinator limit in PostgreSQL mode.
- Each center receives a 12-character code. Learners register with that code and await approval. Staff use that code plus an exact-email invitation.
- An existing coordinator can invite additional coordinators into the same center. They manage that center together. Other centers remain separate.
- Existing courses, multiple educators, syllabus, learner and educator attendance, lectures, recordings/material links, uploads, notes, assessments, discussion, reports and authenticator workflows are retained.
- Center-scoped PostgreSQL transactions replace the shared Blob-file compare-and-swap conflict. Genuine stale edits of a particular attendance register/record still require refresh; this protects another person's changes.

## Storage and authentication

The backend uses `pg` and the Supabase transaction pooler. Every request runs with a restricted SQL role and a center context; RLS plus server authorization isolate the records. Records are stored individually in center-scoped tables with JSONB payloads. Existing typed data structures and audit history remain intact. This is not a fully normalized university SIS schema.

Brightpath's existing authentication remains: scrypt password hashes, HTTP-only session cookies, recovery keys and optional authenticator MFA. This edition does **not** use Supabase Auth or email verification. Public/publishable keys cannot read account tables. The database password is server-only.

The current adapter locks one center row for each request and loads that center's state. It avoids lost updates and allows different centers to operate independently, but serializes requests inside one center. Existing capacity limits remain (3,000 accounts, 1,000 courses and 64 MiB total attachments per center). For large university-scale use, replace full-center reads with targeted entity repositories and move attachments into private object storage. No claim of load-tested university capacity is made.

## Commands

```sh
npm install
npm run build
npm run db:check
npm start
npm test
```

`db:import` creates a separate center from a private v8 JSON backup; `db:backup` exports one center. See SETUP.md. No live records or demo data are bundled.

Legacy local JSON and Blob adapters are retained for rollback and migration only. Multi-center registration requires `BRIGHTPATH_STORAGE=postgres`.
