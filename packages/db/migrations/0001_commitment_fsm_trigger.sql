-- Generated from @3ngram/schema COMMITMENT_TRANSITIONS — do not edit by hand.
CREATE OR REPLACE FUNCTION enforce_commitment_fsm() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    CASE OLD.status
      WHEN 'open' THEN NEW.status IN ('waiting', 'resolved', 'expired')
      WHEN 'waiting' THEN NEW.status IN ('open', 'resolved', 'expired')
      WHEN 'resolved' THEN NEW.status IN ('open')
      WHEN 'expired' THEN NEW.status IN ('open')
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
