-- The Activity log can't be altered. app_user could already only read and
-- add entries (0004_staff_admin_grants.sql); these triggers hold for every
-- role, the database's owner included: nothing changes or deletes an entry,
-- or empties the table. An entry only goes when its whole shop is removed
-- (by the time a shop's entries are reached, the shop's row is gone).
--
-- Each entry is sealed as the transaction that added it commits: numbered
-- in its shop's order (seq), stamped with the time, given its author's name
-- as it is then, and hashed (SHA-256) together with the hash of the shop's
-- entry before it. An entry changed or taken out behind the triggers' back
-- (an owner can drop them) then no longer matches its hash, or breaks the
-- chain, which the Activity log checks each time it's shown.

-- What an entry's hash is over, as text that comes out the same every
-- time: jsonb writes an object's keys in a fixed order, and the time is UTC
-- to the microsecond.
CREATE FUNCTION audit_log_hash(entry audit_log) RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    entry.shop_id,
    entry.seq,
    to_char(entry.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    entry.actor_user_id,
    entry.actor_name,
    entry.action,
    entry.target_type,
    entry.target_id,
    entry.details,
    entry.prev_hash
  )::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- Seals one entry: the next number in its shop's chain, its author's name,
-- the hash before it and its own, and with stamp the time it's sealed. A
-- shop's entries are sealed one at a time (the lock lasts until the
-- transaction, which is committing, ends), so the numbers follow the order
-- entries are saved in. Leaves an entry that's sealed already, or gone.
CREATE FUNCTION audit_log_seal_entry(entry_id uuid, stamp boolean) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  entry audit_log;
  last audit_log;
BEGIN
  SELECT * INTO entry FROM audit_log WHERE id = entry_id;
  IF NOT FOUND OR entry.hash IS NOT NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('audit_log'), hashtext(entry.shop_id::text));
  SELECT * INTO last FROM audit_log
    WHERE shop_id = entry.shop_id AND seq IS NOT NULL
    ORDER BY seq DESC
    LIMIT 1;
  entry.seq := coalesce(last.seq, 0) + 1;
  entry.prev_hash := last.hash;
  entry.actor_name := (SELECT name FROM users WHERE id = entry.actor_user_id);
  IF stamp THEN
    entry.created_at := clock_timestamp();
  END IF;
  entry.hash := audit_log_hash(entry);
  UPDATE audit_log
    SET seq = entry.seq,
        prev_hash = entry.prev_hash,
        actor_name = entry.actor_name,
        created_at = entry.created_at,
        hash = entry.hash
    WHERE id = entry_id AND hash IS NULL;
END
$$;
--> statement-breakpoint
-- Only the seal runs it, as the owner.
REVOKE EXECUTE ON FUNCTION audit_log_seal_entry(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
-- At commit, for each entry the transaction added, in the order it added
-- them. It runs as the owner, who can fill in the chain's fields; app_user
-- can't change an entry at all.
CREATE FUNCTION audit_log_seal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM audit_log_seal_entry(NEW.id, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER audit_log_seal AFTER INSERT ON audit_log
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION audit_log_seal();
--> statement-breakpoint
-- The chain's fields are the seal's to fill in, whatever an insert gives.
CREATE FUNCTION audit_log_new_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.seq := NULL;
  NEW.actor_name := NULL;
  NEW.prev_hash := NULL;
  NEW.hash := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_new_entry BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_new_entry();
--> statement-breakpoint
-- Refuses every change, delete and truncate, but for sealing an entry (its
-- chain's fields filled in, once, the rest as it was) and an entry going
-- with its shop.
CREATE FUNCTION audit_log_unchangeable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    IF NOT EXISTS (SELECT 1 FROM shops WHERE id = OLD.shop_id) THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.hash IS NULL AND NEW.hash IS NOT NULL
      AND (NEW.id, NEW.shop_id, NEW.actor_user_id, NEW.action, NEW.target_type, NEW.target_id, NEW.details)
        IS NOT DISTINCT FROM (OLD.id, OLD.shop_id, OLD.actor_user_id, OLD.action, OLD.target_type, OLD.target_id, OLD.details) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'The activity log can''t be changed or deleted: it''s the shop''s permanent record.'
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_unchangeable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_unchangeable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_unchangeable();
--> statement-breakpoint
-- Seals the entries already in the log, each shop's in the order they were
-- made, keeping their times.
DO $$
DECLARE
  entry_id uuid;
BEGIN
  FOR entry_id IN SELECT id FROM audit_log WHERE hash IS NULL ORDER BY shop_id, created_at, id LOOP
    PERFORM audit_log_seal_entry(entry_id, false);
  END LOOP;
END
$$;
