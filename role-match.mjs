// role-match.mjs — role-title fuzzy matching for tracker dedup.
//
// Extracted from merge-tracker.mjs so it can be unit-tested in isolation
// (merge-tracker.mjs runs its merge at import time, so it can't be imported
// safely). Pure functions, no side effects.

// Tokens that almost every role shares — must NOT count as signal.
// Includes seniority, work-mode, contract, and common locations.
const ROLE_STOPWORDS = new Set([
  // seniority / level
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  // contract / mode
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'intern', 'internship',
  // generic job words
  'role', 'position', 'opportunity', 'team', 'based',
  // very common locations (extend in portals.yml later if needed)
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  // regions / countries
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  // prepositions leaking through length filter
  'with', 'from', 'into', 'over', 'this', 'that',
]);

// Short specialty acronyms that ARE discriminating despite their length.
// Without this allowlist, `length > 3` strips them out, leaving only the
// generic "Software Engineer" baseline (see Issue #633).
//
// Deliberately narrow: includes tokens like 'api' / 'sre' / 'sdk' that name
// a specific team or technology, and excludes broad ones like 'ai' / 'ml' /
// 'llm' that appear across many roles (AI Engineer, ML Manager, etc.).
// Adding the broad ones would regress #329's AI Success/Deployment case.
const SHORT_SPECIALTY = new Set([
  'api', 'sre', 'sdk', 'cli', 'gpu', 'cpu',
  'ios', 'qa', 'ux', 'ui', 'ar', 'vr',
  'ocr', 'crm', 'erp',
]);

// Generic role-level descriptors. Two roles whose ONLY overlap is in this
// set (e.g. [software, engineer]) are NOT the same role — they're just
// labelled at the same altitude. See Issue #633: "Staff SWE, API" vs
// "Staff SWE, Kubernetes Platform" share [software, engineer] only.
const BASELINE_TOKENS = new Set([
  'software', 'engineer', 'developer', 'manager', 'architect',
  'analyst', 'designer', 'consultant', 'specialist',
  'platform', 'systems', 'services',
  'backend', 'frontend', 'fullstack',
]);

export function roleTokens(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => (w.length > 3 || SHORT_SPECIALTY.has(w)) && !ROLE_STOPWORDS.has(w));
}

export function roleFuzzyMatch(a, b) {
  const wordsA = roleTokens(a);
  const wordsB = roleTokens(b);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w));
  if (overlap.length < 2) return false;

  // Require at least one non-baseline token in the overlap. Roles that
  // share only generic descriptors like [software, engineer] are NOT the
  // same role (see Issue #633).
  const discriminating = overlap.filter(w => !BASELINE_TOKENS.has(w));
  if (discriminating.length === 0) return false;

  // Same family, different specialization? If EACH role carries a token the
  // other lacks (e.g. "…Industries" vs "…Enterprise Tech"), they are distinct
  // roles in a family — never collapse them. Failing open here (a separate row)
  // is far safer than silently overwriting a real, differently-scoped role.
  // Asymmetric difference still dedupes ("Solutions Architect" vs "Senior
  // Solutions Architect" → "senior" is a stopword → no unique token → merges).
  const setA = new Set(wordsA);
  const uniqueA = wordsA.filter(w => !setB.has(w));
  const uniqueB = wordsB.filter(w => !setA.has(w));
  if (uniqueA.length > 0 && uniqueB.length > 0) return false;

  // Jaccard-style ratio on content tokens. Two roles are "the same" only
  // when the overlap dominates the smaller side — not when they just share
  // a location + "engineer".
  const minLen = Math.min(wordsA.length, wordsB.length);
  const ratio = overlap.length / minLen;
  return ratio >= 0.6;
}
