-- Brightpath v9: run this entire file in Supabase > SQL Editor as postgres.
-- Additive and repeatable. Does not touch auth.users, public tables or Blob files.
-- Browser keys have NO access to these tables. All operations go through /api.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='brightpath_runtime') THEN
  CREATE ROLE brightpath_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
GRANT brightpath_runtime TO postgres;
CREATE SCHEMA IF NOT EXISTS brightpath_private;
REVOKE ALL ON SCHEMA brightpath_private FROM PUBLIC;
GRANT USAGE ON SCHEMA brightpath_private TO brightpath_runtime;
CREATE TABLE IF NOT EXISTS brightpath_private.centers (
 id uuid PRIMARY KEY,
 code text NOT NULL UNIQUE CHECK(code ~ '^[A-Z0-9]{12}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120),
 settings jsonb NOT NULL DEFAULT '{"requireStaffMfa":false}',
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE brightpath_private.centers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS center_scope ON brightpath_private.centers;
CREATE POLICY center_scope ON brightpath_private.centers TO brightpath_runtime
 USING(id = nullif(current_setting('brightpath.center_id',true),'')::uuid)
 WITH CHECK(id = nullif(current_setting('brightpath.center_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON brightpath_private.centers TO brightpath_runtime;
-- Each application record has its own SQL row, scoped by center_id.
-- JSONB preserves existing attendance audit structures and learning workflows.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['users','sessions','invites','courses','enrollments','items','quiz_keys','files','limits','events','notifications'] LOOP
  EXECUTE format('CREATE TABLE IF NOT EXISTS brightpath_private.%I (center_id uuid NOT NULL REFERENCES brightpath_private.centers(id), record_key text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(center_id,record_key))',tab);
  EXECUTE format('ALTER TABLE brightpath_private.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('DROP POLICY IF EXISTS center_scope ON brightpath_private.%I',tab);
  EXECUTE format('CREATE POLICY center_scope ON brightpath_private.%I TO brightpath_runtime USING(center_id = nullif(current_setting(''brightpath.center_id'',true),'''')::uuid) WITH CHECK(center_id = nullif(current_setting(''brightpath.center_id'',true),'''')::uuid)',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON brightpath_private.%I TO brightpath_runtime',tab);
  EXECUTE format('REVOKE ALL ON brightpath_private.%I FROM PUBLIC',tab);
 END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS bp_user_email_per_center ON brightpath_private.users(center_id,lower(data->>'email'));
CREATE INDEX IF NOT EXISTS bp_items_course ON brightpath_private.items(center_id,(data->>'courseId'));
CREATE INDEX IF NOT EXISTS bp_enrollments_course ON brightpath_private.enrollments(center_id,(data->>'course_id'));
-- Only the trusted backend can resolve a supplied center code. No listing API.
CREATE OR REPLACE FUNCTION brightpath_private.resolve_center(wanted_code text)
 RETURNS TABLE(id uuid,code text,name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,brightpath_private
 AS $$ SELECT c.id,c.code,c.name FROM brightpath_private.centers c WHERE c.code=wanted_code $$;
REVOKE ALL ON FUNCTION brightpath_private.resolve_center(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brightpath_private.resolve_center(text) TO brightpath_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA brightpath_private FROM PUBLIC;
-- Supabase API roles must not access custom-auth records directly.
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS (SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON SCHEMA brightpath_private FROM %I',r);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA brightpath_private FROM %I',r);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA brightpath_private FROM %I',r);
  END IF;
 END LOOP;
END $$;
COMMIT;
-- Success: 12 tables in brightpath_private. No test users or demo data inserted.
