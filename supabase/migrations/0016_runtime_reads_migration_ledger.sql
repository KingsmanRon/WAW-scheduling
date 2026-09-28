-- 0016: the API and the worker may read the migration ledger.
--
-- A build knows the newest migration it ships with and reports ready (and
-- the worker starts work) only once the database has applied it, so a
-- release deployed before its migration job never runs on an older schema.
-- The ledger holds version names, checksums and timings only.

GRANT SELECT ON public.schema_migrations TO access_request, access_worker;
