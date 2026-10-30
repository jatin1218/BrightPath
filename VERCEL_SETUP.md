# Vercel setup for v9

Follow **SETUP.md**, especially sections 1, 2, 5 and 6. This release defaults to PostgreSQL on Vercel. Run **sql/001_supabase_multicenter.sql** in Supabase first, then privately configure DATABASE_URL and BRIGHTPATH_STORAGE=postgres in the existing project's Production environment and deploy the updated source.

Do not just redeploy the v8 source with PostgreSQL settings. The older deployment does not include the database adapter. Keep the old private Blob backup until data migration and login have been verified.
