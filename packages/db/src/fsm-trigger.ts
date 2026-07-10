// SPDX-License-Identifier: Apache-2.0
import { COMMITMENT_TRANSITIONS } from '@3ngram/schema'

/**
 * Commitment FSM enforcement trigger, generated from COMMITMENT_TRANSITIONS
 * (schema-PR DoD §4: illegal transitions rejected by the DB, not just the
 * service). The migration file content is asserted against this generator in
 * test/transitions.test.ts — editing one without the other fails CI.
 */
export function commitmentFsmTriggerSql(): string {
  const cases = Object.entries(COMMITMENT_TRANSITIONS)
    .map(
      ([from, targets]) =>
        `      WHEN '${from}' THEN NEW.status IN (${targets.map((t) => `'${t}'`).join(', ')})`,
    )
    .join('\n')

  return `-- Generated from @3ngram/schema COMMITMENT_TRANSITIONS — do not edit by hand.
CREATE OR REPLACE FUNCTION enforce_commitment_fsm() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    CASE OLD.status
${cases}
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'illegal commitment transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commitments_fsm_guard ON commitments;
CREATE TRIGGER commitments_fsm_guard
  BEFORE UPDATE OF status ON commitments
  FOR EACH ROW EXECUTE FUNCTION enforce_commitment_fsm();
`
}
