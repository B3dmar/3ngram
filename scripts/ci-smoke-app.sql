-- SPDX-License-Identifier: Apache-2.0
-- CI smoke, runtime-role phase: RLS + append-only assertions, connected as
-- app_user (NOBYPASSRLS) on the disposable CI pgvector service — through the role
-- that production traffic actually uses. psql -v ON_ERROR_STOP=1.

-- 1. No tenant context => zero rows, and the NULLIF guard must not throw
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM memories;
  IF n <> 0 THEN
    RAISE EXCEPTION 'SMOKE FAIL: unscoped read leaked % rows through RLS', n;
  END IF;
END $$;

-- 2. Tenant context isolates: A sees own row, B sees nothing
DO $$
DECLARE a uuid; b uuid; n int;
BEGIN
  -- resolve ids via SECURITY DEFINER-free path: app_user may read users (system table)
  SELECT id INTO a FROM users WHERE email = 'ci-a@3ngram.test';
  SELECT id INTO b FROM users WHERE email = 'ci-b@3ngram.test';

  PERFORM set_config('app.user_id', a::text, true);
  SELECT count(*) INTO n FROM memories;
  IF n < 1 THEN RAISE EXCEPTION 'SMOKE FAIL: tenant A cannot see own memory'; END IF;

  PERFORM set_config('app.user_id', b::text, true);
  SELECT count(*) INTO n FROM memories;
  IF n <> 0 THEN RAISE EXCEPTION 'SMOKE FAIL: tenant B sees % foreign rows', n; END IF;
END $$;

-- 3. Append-only: UPDATE on memory_events must be permission-denied
DO $$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    UPDATE memory_events SET event_kind = 'create';
  EXCEPTION WHEN insufficient_privilege THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'SMOKE FAIL: memory_events UPDATE was not denied (append-only grant missing)';
  END IF;
END $$;

SELECT 'app_user smoke: OK' AS result;
