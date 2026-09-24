-- Accounts: name the two Cursor accounts by the same convention as Claude and Codex.
--
-- What this corrects. 20260924080000 split the Mac's Cursor out of cursor-primary but named the halves
-- the wrong way round: it created cursor-work for the Mac and left the PC on cursor-primary. The
-- convention everywhere else is that *-primary is the Mac, the work machine (claude-primary and
-- codex-primary are bound there, and so is the Work browser), and *-personal is the PC
-- (claude-personal). This file makes Cursor match: the PC's Cursor becomes cursor-personal, the Mac's
-- Cursor becomes cursor-primary, and the cursor-work account, created an hour earlier, is removed.
--
-- Why whole-account moves. Verified read-only on 2026-09-24 just before this was written: every row
-- under cursor-primary belongs to the PC binding (ca6d57ae, source 6b474e4e) and every row under
-- cursor-work belongs to the Mac binding (eb1c8a26, source f02e726b), in every table that references
-- usage_accounts: cursor-primary held 192 allowance readings, 8,713 request revisions with their 8,713
-- canonical_requests rows, 113 usage buckets and 57 money entries; cursor-work held 192 readings, 72
-- revisions and 72 canonical_requests rows. So each account moves as a whole into an account that is
-- empty at that moment, which cannot collide on any key that includes account_id and leaves the
-- canonical_requests projection exactly as a recompute would. Nothing is deleted except the empty
-- cursor-work account itself, and its foreign keys make that DELETE fail if anything still points at it.
--
-- Collectors. Ingest takes each row's account from companion_bindings, so both machines' uploads follow
-- the binding. A companion's local companion.json account_id feeds only its identity pin; the PC's
-- still reads cursor-primary and keeps working unchanged (its pin does not move), and the Mac's is set
-- back to cursor-primary alongside this file.
--
-- Safety on live data. Ingest reads bindings without a row lock, so an upload in flight while this runs
-- could still commit rows under the old account. Apply it between the machines' hourly runs with the
-- Mac companion paused, then rerun the verification query. Counts are lower bounds.
--
-- Production only. The Mac's Cursor binding exists in production and nowhere else, so on any other
-- database (the disposable cluster `npm run test:db` builds) this file does nothing.
SET lock_timeout = '10s';
SET statement_timeout = '5min';

DO $$
DECLARE
  pc_binding  constant uuid := 'ca6d57ae-b8c2-477d-957a-d2189b204b7c';
  pc_source   constant uuid := '6b474e4e-34d3-4ff5-a49b-8aefe043a3c6';
  mac_binding constant uuid := 'eb1c8a26-2fd7-4e4a-a988-04ddf56da51c';
  mac_source  constant uuid := 'f02e726b-b29d-4d54-b1ad-de77ade591b8';
  referencing text[];
  t text;
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM personal_hub.companion_bindings WHERE id = mac_binding) THEN
    RAISE NOTICE 'cursor_accounts_follow_machine_convention: not the production dataset, nothing to do';
    RETURN;
  END IF;

  SELECT array_agg(conrelid::regclass::text ORDER BY conrelid::regclass::text) INTO referencing
  FROM pg_constraint WHERE contype = 'f' AND confrelid = 'personal_hub.usage_accounts'::regclass;

  -- Each account must hold exactly one machine's binding before it moves as a whole.
  IF (SELECT array_agg(id) FROM personal_hub.companion_bindings WHERE account_id = 'cursor-primary') IS DISTINCT FROM ARRAY[pc_binding]
     OR (SELECT array_agg(id) FROM personal_hub.telemetry_sources WHERE account_id = 'cursor-primary') IS DISTINCT FROM ARRAY[pc_source] THEN
    RAISE EXCEPTION 'cursor-primary does not hold exactly the PC binding and source';
  END IF;
  IF (SELECT array_agg(id) FROM personal_hub.companion_bindings WHERE account_id = 'cursor-work') IS DISTINCT FROM ARRAY[mac_binding]
     OR (SELECT array_agg(id) FROM personal_hub.telemetry_sources WHERE account_id = 'cursor-work') IS DISTINCT FROM ARRAY[mac_source] THEN
    RAISE EXCEPTION 'cursor-work does not hold exactly the Mac binding and source';
  END IF;
  IF EXISTS (SELECT 1 FROM personal_hub.allowance_readings    WHERE account_id = 'cursor-primary' AND binding_id IS DISTINCT FROM pc_binding)
     OR EXISTS (SELECT 1 FROM personal_hub.activity_requests  WHERE account_id = 'cursor-primary' AND binding_id IS DISTINCT FROM pc_binding)
     OR EXISTS (SELECT 1 FROM personal_hub.canonical_requests WHERE account_id = 'cursor-primary' AND source_id IS DISTINCT FROM pc_source)
     OR EXISTS (SELECT 1 FROM personal_hub.allowance_readings WHERE account_id = 'cursor-work' AND binding_id IS DISTINCT FROM mac_binding)
     OR EXISTS (SELECT 1 FROM personal_hub.activity_requests  WHERE account_id = 'cursor-work' AND binding_id IS DISTINCT FROM mac_binding)
     OR EXISTS (SELECT 1 FROM personal_hub.canonical_requests WHERE account_id = 'cursor-work' AND source_id IS DISTINCT FROM mac_source) THEN
    RAISE EXCEPTION 'a Cursor account holds rows from the other machine';
  END IF;

  -- 1. The PC: cursor-primary -> cursor-personal.
  INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES ('cursor-personal', 'cursor', 'Cursor · personal');
  FOREACH t IN ARRAY referencing LOOP
    EXECUTE format('UPDATE %s SET account_id = %L WHERE account_id = %L', t, 'cursor-personal', 'cursor-primary');
  END LOOP;

  -- 2. The Mac: cursor-work -> cursor-primary, which step 1 left empty.
  UPDATE personal_hub.usage_accounts SET label = 'Cursor · primary' WHERE id = 'cursor-primary';
  FOREACH t IN ARRAY referencing LOOP
    EXECUTE format('UPDATE %s SET account_id = %L WHERE account_id = %L', t, 'cursor-primary', 'cursor-work');
  END LOOP;

  -- 3. cursor-work is now unreferenced; its foreign keys refuse the DELETE otherwise.
  DELETE FROM personal_hub.usage_accounts WHERE id = 'cursor-work';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected to remove the cursor-work account, removed %', n; END IF;

  -- Where everything ended up.
  IF (SELECT account_id FROM personal_hub.companion_bindings WHERE id = pc_binding) IS DISTINCT FROM 'cursor-personal'
     OR (SELECT account_id FROM personal_hub.telemetry_sources WHERE id = pc_source) IS DISTINCT FROM 'cursor-personal'
     OR (SELECT account_id FROM personal_hub.companion_bindings WHERE id = mac_binding) IS DISTINCT FROM 'cursor-primary'
     OR (SELECT account_id FROM personal_hub.telemetry_sources WHERE id = mac_source) IS DISTINCT FROM 'cursor-primary' THEN
    RAISE EXCEPTION 'a Cursor binding or source is not on its expected account';
  END IF;
  SELECT count(*) INTO n FROM personal_hub.allowance_readings WHERE account_id = 'cursor-personal';
  IF n < 192 THEN RAISE EXCEPTION 'cursor-personal: expected at least 192 allowance readings, got %', n; END IF;
  SELECT count(*) INTO n FROM personal_hub.activity_requests WHERE account_id = 'cursor-personal';
  IF n < 8713 THEN RAISE EXCEPTION 'cursor-personal: expected at least 8713 request revisions, got %', n; END IF;
  SELECT count(*) INTO n FROM personal_hub.canonical_requests WHERE account_id = 'cursor-personal';
  IF n < 8713 THEN RAISE EXCEPTION 'cursor-personal: expected at least 8713 canonical requests, got %', n; END IF;
  SELECT count(*) INTO n FROM personal_hub.account_usage_buckets WHERE account_id = 'cursor-personal';
  IF n < 113 THEN RAISE EXCEPTION 'cursor-personal: expected at least 113 usage buckets, got %', n; END IF;
  SELECT count(*) INTO n FROM personal_hub.money_entries WHERE account_id = 'cursor-personal';
  IF n < 57 THEN RAISE EXCEPTION 'cursor-personal: expected at least 57 money entries, got %', n; END IF;
  SELECT count(*) INTO n FROM personal_hub.allowance_readings WHERE account_id = 'cursor-primary';
  IF n < 192 THEN RAISE EXCEPTION 'cursor-primary: expected at least 192 allowance readings, got %', n; END IF;
  SELECT count(*) INTO n FROM personal_hub.activity_requests WHERE account_id = 'cursor-primary';
  IF n < 72 THEN RAISE EXCEPTION 'cursor-primary: expected at least 72 request revisions, got %', n; END IF;
  SELECT count(*) INTO n FROM personal_hub.canonical_requests WHERE account_id = 'cursor-primary';
  IF n < 72 THEN RAISE EXCEPTION 'cursor-primary: expected at least 72 canonical requests, got %', n; END IF;
  IF EXISTS (SELECT 1 FROM personal_hub.allowance_readings WHERE account_id = 'cursor-primary' AND binding_id IS DISTINCT FROM mac_binding)
     OR EXISTS (SELECT 1 FROM personal_hub.activity_requests WHERE account_id = 'cursor-primary' AND binding_id IS DISTINCT FROM mac_binding)
     OR EXISTS (SELECT 1 FROM personal_hub.allowance_readings WHERE account_id = 'cursor-personal' AND binding_id IS DISTINCT FROM pc_binding)
     OR EXISTS (SELECT 1 FROM personal_hub.activity_requests WHERE account_id = 'cursor-personal' AND binding_id IS DISTINCT FROM pc_binding) THEN
    RAISE EXCEPTION 'a Cursor account ended up with the other machine''s rows';
  END IF;
END $$;
