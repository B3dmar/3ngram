-- SPDX-License-Identifier: Apache-2.0
-- CI smoke, owner phase: seed + FSM trigger assertions (runs after migrate +
-- provision-roles on the disposable CI pgvector service). psql -v ON_ERROR_STOP=1.

INSERT INTO users (email, password_hash) VALUES ('ci-a@3ngram.test','x'), ('ci-b@3ngram.test','x')
ON CONFLICT (email) DO NOTHING;

-- FSM: legal transition succeeds, illegal transition MUST raise
DO $$
DECLARE
  uid uuid; mid uuid; caught boolean := false;
BEGIN
  SELECT id INTO uid FROM users WHERE email = 'ci-a@3ngram.test';
  INSERT INTO memories (user_id, memory_type, topic, content, content_hash)
    VALUES (uid, 'commitment', 'ci-fsm', 'x', 'ci-fsm-hash') RETURNING id INTO mid;
  INSERT INTO commitments (user_id, memory_id) VALUES (uid, mid);
  UPDATE commitments SET status = 'resolved' WHERE memory_id = mid; -- legal
  BEGIN
    UPDATE commitments SET status = 'expired' WHERE memory_id = mid; -- illegal
  EXCEPTION WHEN check_violation THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'SMOKE FAIL: illegal FSM transition resolved->expired was not rejected';
  END IF;
END $$;

SELECT 'owner smoke: OK' AS result;
