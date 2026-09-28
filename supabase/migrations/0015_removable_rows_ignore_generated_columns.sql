-- 0015: removing working hours, leave/exceptions and blocks works.
--
-- scheduling.removable_only_guard() (0009) refuses any update of a
-- configuration row other than recording its removal, by comparing the
-- whole old and new rows. PostgreSQL computes stored generated columns
-- (`period`, `minutes`, `validity`) after BEFORE triggers run, so NEW does
-- not carry them yet and every removal was refused as an edit. The guard
-- now leaves generated columns out of the comparison; they follow from the
-- stored columns it still compares.

CREATE OR REPLACE FUNCTION scheduling.removable_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ignored text[] := ARRAY['removed_at','removed_by','removal_reason'] || ARRAY(
    SELECT a.attname::text FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed % row is final', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ignored) IS DISTINCT FROM (to_jsonb(OLD) - ignored) THEN
    RAISE EXCEPTION '% rows are immutable; remove and re-create instead', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
