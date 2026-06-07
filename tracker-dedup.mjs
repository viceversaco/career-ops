// tracker-dedup.mjs — pure dedup/update decisions for merge-tracker.mjs.
//
// Extracted so the logic can be unit-tested without running the merge, which
// merge-tracker.mjs performs at import time. Tested in test-all.mjs section 14.

import { roleFuzzyMatch } from './role-match.mjs';

export function normalizeCompany(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function extractReportNum(reportStr) {
  const m = String(reportStr).match(/\[(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

function normalizeRole(r) {
  return String(r).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Find the existing entry an addition should update, or null for a new entry.
 *
 * Match precedence:
 *   1. Same report number          — the literal same evaluation (idempotency).
 *   2. Same company + EXACT role    — what a re-score of an existing row produces.
 *   3. Same company + fuzzy role    — genuine variations (seniority, qualifiers).
 *
 * The EXACT tier (2) sits before fuzzy on purpose: a re-score reuses the
 * identical role string, so it pins the right row even when a *sibling* role at
 * the same company would fuzzy-collapse with it — e.g. the shared role matcher
 * can't tell "…AI/ML" from "…Data Engineering & Observability" (it drops ai/ml
 * as non-discriminating). Exact-first makes the re-score order-independent.
 *
 * It deliberately does NOT match on entry-number alone. Entry numbers are a
 * separate sequence from report numbers and get reused across unrelated roles,
 * so a bare `num === num` match once overwrote a *different* role's row and
 * left a duplicate (the #148 incident). Company+role is the reliable identity.
 */
export function findDuplicate(addition, existingApps) {
  const reportNum = extractReportNum(addition.report);
  if (reportNum != null) {
    const byReport = existingApps.find((app) => extractReportNum(app.report) === reportNum);
    if (byReport) return byReport;
  }
  const normCompany = normalizeCompany(addition.company);
  const sameCompany = (app) => normalizeCompany(app.company) === normCompany;

  const addRole = normalizeRole(addition.role);
  const exact = existingApps.find((app) => sameCompany(app) && normalizeRole(app.role) === addRole);
  if (exact) return exact;

  return existingApps.find((app) => sameCompany(app) && roleFuzzyMatch(addition.role, app.role)) || null;
}

/**
 * A re-evaluation is authoritative: it updates the matched row regardless of
 * whether the new score is higher or lower. Only a STALE addition — one whose
 * date is older than the existing row's date — is skipped, so an old re-added
 * TSV can't clobber a newer entry. (Replaces the old "higher score wins" rule,
 * which silently rejected intentional re-score downgrades.)
 */
export function isStaleReeval(addition, duplicate) {
  return Boolean(addition.date && duplicate.date && addition.date < duplicate.date);
}
