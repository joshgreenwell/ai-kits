-- Accounts: split the Mac's Cursor out of cursor-primary into its own cursor-work account.
--
-- What this moves and why. Both machines bound their Cursor to cursor-primary, but they are two
-- different Cursor accounts: the Mac (install 2cf53a04, binding eb1c8a26, source f02e726b, identity
-- e66233ba7785...) is the work account and the PC (binding ca6d57ae, source 6b474e4e, identity
-- a75a1039452a...) is the personal one. Sharing an account merged two allowances into one series, so
-- the Cursor charts alternated between the two plans' readings. This file creates cursor-work, relabels
-- cursor-primary "Cursor · personal" (the id stays, so the PC's collector needs no change), and re-points
-- the Mac binding and every row it produced. Measured read-only on 2026-09-24 just before this was
-- written: 1 binding, 1 telemetry source, 190 allowance readings, 72 request revisions and their 72
-- canonical_requests rows; zero rows in every other ledger. Nothing is deleted.
--
-- Why a plain UPDATE is a correct projection rebuild. canonical_requests is keyed (account_id,
-- semantic_key) and picks one revision per key. None of the Mac binding's semantic keys is shared with
-- any other cursor-primary revision (verified: 0), and every projection row's source_id agrees with its
-- revision's binding, so each moved key has exactly one candidate in each account before and after the
-- move. Updating account_id on those 72 rows is the same result a recompute would produce.
--
-- Where new rows land. Ingest copies companion_bindings.account_id onto every row it inserts, so once
-- the binding is re-pointed, the Mac's uploads go to cursor-work. The companion's local companion.json
-- carries its own account_id per binding, used only in its identity pin; edit it to cursor-work
-- alongside this file (the pin refreshes because the server's identity hash still agrees).
--
-- Safety on live data. Ingest reads bindings without a row lock, so an upload from the Mac that is in
-- flight while this runs could still commit rows under cursor-primary. Pause the Mac companion while this
-- applies. The PC never writes rows for the Mac binding. The final block asserts that no row of the Mac
-- binding or source remains under cursor-primary; rerun the verification query afterwards to cover any
-- upload that committed after this transaction. The counts are lower bounds because the Mac may upload
-- between the measurement and the apply.
--
-- Production only. The Mac's Cursor binding exists in production and nowhere else, so on any other
-- database (the disposable cluster `npm run test:db` builds) this file does nothing.
SET lock_timeout = '10s';
SET statement_timeout = '5min';

DO $$
DECLARE
  mac_binding constant uuid := 'eb1c8a26-2fd7-4e4a-a988-04ddf56da51c';
  mac_source  constant uuid := 'f02e726b-b29d-4d54-b1ad-de77ade591b8';
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM personal_hub.companion_bindings WHERE id = mac_binding) THEN
    RAISE NOTICE 'split_cursor_work_account: not the production dataset, nothing to do';
    RETURN;
  END IF;

  INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES ('cursor-work', 'cursor', 'Cursor · work');
  UPDATE personal_hub.usage_accounts SET label = 'Cursor · personal' WHERE id = 'cursor-primary';

  UPDATE personal_hub.companion_bindings SET account_id = 'cursor-work'
  WHERE id = mac_binding AND account_id = 'cursor-primary' AND provider = 'cursor'
    AND source_id = mac_source AND identity_hash LIKE 'e66233ba7785%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'companion_bindings: expected 1 Mac Cursor binding, got %', n; END IF;

  UPDATE personal_hub.telemetry_sources SET account_id = 'cursor-work'
  WHERE id = mac_source AND account_id = 'cursor-primary';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'telemetry_sources: expected 1 Mac Cursor source, got %', n; END IF;

  UPDATE personal_hub.allowance_readings SET account_id = 'cursor-work'
  WHERE account_id = 'cursor-primary' AND binding_id = mac_binding;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n < 190 THEN RAISE EXCEPTION 'allowance_readings: expected at least 190 rows, got %', n; END IF;

  UPDATE personal_hub.activity_requests SET account_id = 'cursor-work'
  WHERE account_id = 'cursor-primary' AND binding_id = mac_binding;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n < 72 THEN RAISE EXCEPTION 'activity_requests: expected at least 72 rows, got %', n; END IF;

  UPDATE personal_hub.canonical_requests SET account_id = 'cursor-work'
  WHERE account_id = 'cursor-primary' AND source_id = mac_source;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n < 72 THEN RAISE EXCEPTION 'canonical_requests: expected at least 72 rows, got %', n; END IF;

  -- Empty for this binding on 2026-09-24; moved anyway so nothing of it can stay behind.
  UPDATE personal_hub.account_usage_buckets      SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND binding_id = mac_binding;
  UPDATE personal_hub.money_entries              SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND binding_id = mac_binding;
  UPDATE personal_hub.agent_events               SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND binding_id = mac_binding;
  UPDATE personal_hub.tool_events                SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND binding_id = mac_binding;
  UPDATE personal_hub.resource_accesses          SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND binding_id = mac_binding;
  UPDATE personal_hub.agent_routing_events       SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND source_id = mac_source;
  UPDATE personal_hub.canonical_tool_invocations SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND source_id = mac_source;
  UPDATE personal_hub.quota_samples              SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND source_id = mac_source;
  UPDATE personal_hub.token_bucket_revisions     SET account_id = 'cursor-work' WHERE account_id = 'cursor-primary' AND source_id = mac_source;

  SELECT (SELECT count(*) FROM personal_hub.allowance_readings    WHERE account_id = 'cursor-primary' AND binding_id = mac_binding)
       + (SELECT count(*) FROM personal_hub.activity_requests     WHERE account_id = 'cursor-primary' AND binding_id = mac_binding)
       + (SELECT count(*) FROM personal_hub.canonical_requests    WHERE account_id = 'cursor-primary' AND source_id = mac_source)
       + (SELECT count(*) FROM personal_hub.account_usage_buckets WHERE account_id = 'cursor-primary' AND binding_id = mac_binding)
       + (SELECT count(*) FROM personal_hub.money_entries         WHERE account_id = 'cursor-primary' AND binding_id = mac_binding)
       + (SELECT count(*) FROM personal_hub.companion_bindings    WHERE account_id = 'cursor-primary' AND id = mac_binding)
       + (SELECT count(*) FROM personal_hub.telemetry_sources     WHERE account_id = 'cursor-primary' AND id = mac_source)
    INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'Mac Cursor rows still under cursor-primary: %', n; END IF;

  -- The PC's binding must be untouched.
  IF NOT EXISTS (SELECT 1 FROM personal_hub.companion_bindings
                 WHERE id = 'ca6d57ae-b8c2-477d-957a-d2189b204b7c' AND account_id = 'cursor-primary') THEN
    RAISE EXCEPTION 'the PC Cursor binding is no longer on cursor-primary';
  END IF;
END $$;
