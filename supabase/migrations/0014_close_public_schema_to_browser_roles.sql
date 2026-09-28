-- 0014: Supabase's browser and service roles lose everything in public.
--
-- On Supabase, every table, sequence and function the owner creates in the
-- public schema is granted to anon, authenticated and service_role, and
-- public is served by the Data API to anyone holding the anon key (which the
-- console necessarily ships). The organisation-workspace tables from
-- 0001-0006 live in public and kept those grants; two of them carry no
-- row-level security (the tenant catalogue `organisations` and the migration
-- ledger `schema_migrations`).
--
-- ACCESS never uses the Data API: browsers call the ACCESS API and read one
-- Realtime signal table (0010), and the service key is used for Storage
-- only. This withdraws every privilege those roles hold in public and stops
-- tables the owner creates there later from inheriting them. Runtime logins
-- (access_request, access_worker) are unaffected. Skipped on plain
-- PostgreSQL, where the roles do not exist.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
