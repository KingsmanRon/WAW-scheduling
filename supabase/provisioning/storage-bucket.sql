-- Run once per Supabase project as the owner (SQL editor or psql):
--   psql "$MIGRATION_DATABASE_URL" -v bucket=access-artifacts -f supabase/provisioning/storage-bucket.sql
-- Creates the PRIVATE artifact bucket used by ARTIFACT_STORE=supabase.
-- ACCESS uploads only application-encrypted ciphertext with the service-role
-- key from the API server. No storage.objects policy is created for the anon
-- or authenticated roles, so browsers can neither list nor read objects, and
-- ACCESS never issues public or signed URLs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (:'bucket', :'bucket', false, 12582912, ARRAY['application/octet-stream'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
-- Verification: must return public = false and no policies naming the bucket.
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = :'bucket';
SELECT policyname, roles, qual FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects' AND (qual ILIKE '%' || :'bucket' || '%' OR with_check ILIKE '%' || :'bucket' || '%');
