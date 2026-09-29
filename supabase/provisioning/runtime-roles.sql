-- Run as migration owner with uncommitted password values:
-- psql "$MIGRATION_DATABASE_URL" --set=api_password='...' --set=worker_password='...' -f supabase/provisioning/runtime-roles.sql
ALTER ROLE access_request LOGIN PASSWORD :'api_password' CONNECTION LIMIT 20;
ALTER ROLE access_worker LOGIN PASSWORD :'worker_password' CONNECTION LIMIT 10;
ALTER ROLE access_request NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE access_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
SELECT rolname,rolsuper,rolinherit,rolbypassrls FROM pg_roles WHERE rolname IN ('access_request','access_worker');
SELECT r.rolname,count(c.oid) AS owned_tables FROM pg_roles r LEFT JOIN pg_class c ON c.relowner=r.oid AND c.relkind='r' WHERE r.rolname IN ('access_request','access_worker') GROUP BY r.rolname;
