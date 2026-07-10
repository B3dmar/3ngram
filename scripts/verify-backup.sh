#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Backup-verification check for the hosted Neon database.
#
# Durability in v1 is delegated to Neon PITR + branching. This script
# proves the point-in-time-restore window is healthy and WIDE ENOUGH to meet the
# operator's RPO/retention target. It is READ-ONLY:
# it never mutates Neon and NEVER executes a restore (a real restore is a
# separate operator drill).
#
# Exit codes: 0 = PASS (or clean SKIP), 1 = FAIL (retention too narrow / API error),
# 2 = misconfiguration.
#
# Required env (hosted cron / CI):
#   NEON_API_KEY     Neon API key (read scope is sufficient)
#   NEON_PROJECT_ID  Production Neon project id
# Optional env:
#   BACKUP_MIN_RETENTION_DAYS  Minimum acceptable PITR window in days (default 7)
#   VERIFY_BACKUP_OPTIONAL     If "1", an unconfigured run SKIPs (exit 0) instead
#                              of failing — for self-host/local where the operator
#                              owns their own backup posture.
set -euo pipefail

MIN_RETENTION_DAYS="${BACKUP_MIN_RETENTION_DAYS:-7}"
NEON_API_BASE="${NEON_API_BASE:-https://console.neon.tech/api/v2}"

fail() { echo "verify-backup: FAIL: $*" >&2; exit 1; }
misconfig() { echo "verify-backup: $*" >&2; exit 2; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || misconfig "required tool '$tool' not found on PATH"
done

if [[ -z "${NEON_API_KEY:-}" || -z "${NEON_PROJECT_ID:-}" ]]; then
  if [[ "${VERIFY_BACKUP_OPTIONAL:-}" == "1" ]]; then
    echo "verify-backup: SKIP — NEON_API_KEY/NEON_PROJECT_ID unset (VERIFY_BACKUP_OPTIONAL=1)"
    exit 0
  fi
  misconfig "NEON_API_KEY and NEON_PROJECT_ID must be set (set VERIFY_BACKUP_OPTIONAL=1 to skip)"
fi

# --- Query the project: history_retention_seconds is the PITR window. ----------
project_json=$(
  curl -fsS --max-time 30 \
    -H "Authorization: Bearer ${NEON_API_KEY}" \
    -H "Accept: application/json" \
    "${NEON_API_BASE}/projects/${NEON_PROJECT_ID}"
) || fail "Neon API request for project ${NEON_PROJECT_ID} failed"

retention_seconds=$(jq -r '.project.history_retention_seconds // empty' <<<"$project_json")
[[ -n "$retention_seconds" && "$retention_seconds" =~ ^[0-9]+$ ]] \
  || fail "could not read history_retention_seconds from the Neon API response"

retention_days=$(( retention_seconds / 86400 ))

# --- Freshness: most recent branch activity (informational, not a gate). -------
branches_json=$(
  curl -fsS --max-time 30 \
    -H "Authorization: Bearer ${NEON_API_KEY}" \
    -H "Accept: application/json" \
    "${NEON_API_BASE}/projects/${NEON_PROJECT_ID}/branches"
) || fail "Neon API request for branches failed"

latest_activity=$(jq -r '[.branches[].updated_at] | max // "unknown"' <<<"$branches_json")

echo "verify-backup: PITR window = ${retention_days}d (${retention_seconds}s); minimum required = ${MIN_RETENTION_DAYS}d"
echo "verify-backup: most recent branch activity = ${latest_activity}"

if (( retention_days < MIN_RETENTION_DAYS )); then
  fail "PITR retention ${retention_days}d is below the required ${MIN_RETENTION_DAYS}d — RPO/retention target not met (#466)"
fi

echo "verify-backup: PASS — PITR window covers the retention target; restore-in-principle is intact."
