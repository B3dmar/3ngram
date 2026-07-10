-- Billing cost-tier readiness: set per-tier caps + the llm_generation
-- capability flag as DATA (no schema change), grounded in the LLM cost-routing
-- model. Caps are operator-editable runtime
-- data; this upgrade preserves operator edits where it safely can:
--   * llm_generation is MERGED into capabilities (jsonb ||) — only the flag this
--     migration introduces is set (Free embeds only -> false; Pro/Team may use
--     complete() -> true); any operator-custom keys are preserved.
--   * Free cap: raise ANY value BELOW the $10 NoOpGate fallback up to $10 — this is
--  the floor (so a later StripeGate never tightens free below
--     config.defaultCapUsd, incl. an operator-lowered $5 row); a Free cap already
--     >= $10 is an operator choice and is preserved.
--   * Pro cap: raise ONLY the untouched 0022 seed ($50 -> $15, margin-aware); an
--     operator-tuned Pro cap (no floor invariant) is preserved.
--   * Team cap stays at its $200 seed, unchanged. Idempotent.
UPDATE "plan_tiers" SET "capabilities" = "capabilities" || '{"llm_generation": false}'::jsonb WHERE "tier" = 'free';
UPDATE "plan_tiers" SET "capabilities" = "capabilities" || '{"llm_generation": true}'::jsonb  WHERE "tier" = 'pro';
UPDATE "plan_tiers" SET "capabilities" = "capabilities" || '{"llm_generation": true}'::jsonb  WHERE "tier" = 'team';
UPDATE "plan_tiers" SET "cap_usd" = 10.000000000000 WHERE "tier" = 'free' AND "cap_usd" < 10.000000000000;
UPDATE "plan_tiers" SET "cap_usd" = 15.000000000000 WHERE "tier" = 'pro'  AND "cap_usd" = 50.000000000000;
