// triage-core.mjs — scan-time triage: ranking + first-pass dedupe.
//
// Fork enhancement (system layer). Pure functions, no side effects — all
// file I/O lives in scan.mjs. The feature is driven by an OPTIONAL `triage:`
// block in portals.yml (user layer): when the block is absent,
// loadTriageConfig() returns null and the scanner behaves exactly as stock
// upstream (every triage step in scan.mjs is guarded on the rules object).
//
// Responsibilities:
//   - loadTriageConfig(portalsConfig)  → normalized rules | null (feature off)
//   - rankOffer(offer, rules)          → { score, tier } with tier ∈ P1/P2/P3/LOW
//   - shouldDiscard(offer, rules)      → matched discard_titles pattern | null
//   - nearDupKey / findNearDups        → within-batch near-duplicate collapse
//   - isFuzzySeenInTracker             → company+fuzzy-role match vs applications.md
//   - pipeline.md tier layout helpers  → pure line-array transforms used by
//     scan.mjs appendToPipelineTiered() and `node scan.mjs --retriage`
//
// Role-title fuzzy matching is imported from role-match.mjs (single source of
// truth shared with merge-tracker) — never duplicate that logic here.

import { roleTokens, roleFuzzyMatch } from './role-match.mjs';

// ── Tier thresholds ─────────────────────────────────────────────────

export const TIER_DEFAULTS = { p1: 50, p2: 30, p3: 10 };

export const TIER_ORDER = ['P1', 'P2', 'P3', 'LOW'];

export const TIER_MARKERS = {
  P1: '<!-- P1: top archetype matches — evaluate first -->',
  P2: '<!-- P2 -->',
  P3: '<!-- P3 -->',
  LOW: '<!-- LOW: agencies / weak matches -->',
};

// Tolerant marker detection — matches the canonical markers above plus any
// hand-edited variant that keeps the `<!-- P1 ...` shape.
const TIER_MARKER_RE = {
  P1: /^<!--\s*P1\b/,
  P2: /^<!--\s*P2\b/,
  P3: /^<!--\s*P3\b/,
  LOW: /^<!--\s*LOW\b/,
};

// ── URL source classification ───────────────────────────────────────

// Native ATS hosts — the canonical place to apply. Preferred when the same
// company+role shows up under several URLs in one batch.
export const NATIVE_ATS_HOSTS = [
  'greenhouse.io', 'ashbyhq.com', 'lever.co', 'myworkdayjobs.com',
  'workable.com', 'smartrecruiters.com', 'recruitee.com', 'bamboohr.com',
  'teamtailor.com', 'jobvite.com', 'icims.com', 'rippling.com',
];

// Aggregators / reposters — same posting, worse application surface.
export const AGGREGATOR_HOSTS = [
  'linkedin.com', 'weworkremotely.com', 'workingnomads.com', 'jooble.org',
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'simplyhired.com',
  'monster.com', 'dice.com', 'remotive.com', 'remoteok.com', 'remote.co',
  'wellfound.com', 'jobright.ai', 'himalayas.app',
];

function hostMatches(host, list) {
  return list.some(h => host === h || host.endsWith('.' + h));
}

// 0 = native ATS, 1 = company domain / unknown, 2 = aggregator.
// Lower is better; ties resolve to first-seen in findNearDups().
export function urlSourceRank(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return 1; }
  if (hostMatches(host, NATIVE_ATS_HOSTS)) return 0;
  if (hostMatches(host, AGGREGATOR_HOSTS)) return 2;
  return 1;
}

// ── Normalization helpers ───────────────────────────────────────────

// Trailing legal-suffix tokens that don't discriminate between companies.
const COMPANY_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'gmbh', 'corp', 'co', 'plc', 'sa', 'bv', 'ag', 'limited', 'incorporated']);

export function normalizeCompany(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// Title matcher: word-boundary regex for simple patterns (starts and ends on
// an alphanumeric — covers "Forward Deployed", "Pre-Sales"), case-insensitive
// substring otherwise (covers patterns like ".NET" where \b misbehaves).
function makeTitleMatcher(pattern) {
  const p = String(pattern).trim();
  if (/^[a-z0-9].*[a-z0-9]$/i.test(p) || /^[a-z0-9]$/i.test(p)) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'i');
    return (title) => re.test(title);
  }
  const lower = p.toLowerCase();
  return (title) => title.toLowerCase().includes(lower);
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── Config ──────────────────────────────────────────────────────────

// Normalize the optional `triage:` block from portals.yml. Returns null when
// the block is absent or malformed → feature off, scanner behaves as stock.
// `portalsConfig.title_filter.seniority_boost` is reused for the seniority
// nudge so the keyword list isn't maintained twice.
export function loadTriageConfig(portalsConfig) {
  const t = portalsConfig?.triage;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;

  const titleBoosts = (Array.isArray(t.title_boosts) ? t.title_boosts : [])
    .filter(b => b && typeof b.pattern === 'string' && b.pattern.trim() && Number.isFinite(Number(b.weight)))
    .map(b => ({ pattern: b.pattern, weight: Number(b.weight), matcher: makeTitleMatcher(b.pattern) }));

  const companyBoosts = {};
  if (t.company_boosts && typeof t.company_boosts === 'object' && !Array.isArray(t.company_boosts)) {
    for (const [name, w] of Object.entries(t.company_boosts)) {
      const key = normalizeCompany(name);
      if (key && Number.isFinite(Number(w))) companyBoosts[key] = Number(w);
    }
  }

  const discardTitles = (Array.isArray(t.discard_titles) ? t.discard_titles : [])
    .filter(p => typeof p === 'string' && p.trim())
    .map(p => ({ pattern: p, matcher: makeTitleMatcher(p) }));

  const seniorityMatchers = (Array.isArray(portalsConfig?.title_filter?.seniority_boost)
    ? portalsConfig.title_filter.seniority_boost : [])
    .filter(s => typeof s === 'string' && s.trim())
    .map(s => makeTitleMatcher(s));

  const tiers = {
    p1: toNumber(t.tiers?.p1, TIER_DEFAULTS.p1),
    p2: toNumber(t.tiers?.p2, TIER_DEFAULTS.p2),
    p3: toNumber(t.tiers?.p3, TIER_DEFAULTS.p3),
  };

  return {
    titleBoosts,
    companyBoosts,
    discardTitles,
    seniorityMatchers,
    seniorityBoostWeight: toNumber(t.seniority_boost_weight, 5),
    urlSourcePenalty: toNumber(t.url_source_penalty, 5),
    tiers,
  };
}

// ── Ranking ─────────────────────────────────────────────────────────

// rankOffer({title, company, url, location}, rules) → { score, tier } | null.
// Null rules → null (caller treats triage as a no-op). `context` is reserved
// for future signals (e.g. scan-history recency) and currently unused.
export function rankOffer(offer, rules, context = {}) { // eslint-disable-line no-unused-vars
  if (!rules) return null;
  const title = String(offer?.title || '');
  let score = 0;

  for (const b of rules.titleBoosts) {
    if (b.matcher(title)) score += b.weight;
  }

  const companyBoost = rules.companyBoosts[normalizeCompany(offer?.company)];
  if (companyBoost) score += companyBoost;

  if (rules.seniorityMatchers.some(m => m(title))) score += rules.seniorityBoostWeight;

  if (urlSourceRank(offer?.url) === 2) score -= rules.urlSourcePenalty;

  const { p1, p2, p3 } = rules.tiers;
  const tier = score >= p1 ? 'P1' : score >= p2 ? 'P2' : score >= p3 ? 'P3' : 'LOW';
  return { score, tier };
}

// shouldDiscard(offer, rules) → the matched discard_titles pattern, or null.
// Discarded offers never enter pipeline.md (scan-history status: skipped_triage).
export function shouldDiscard(offer, rules) {
  if (!rules || rules.discardTitles.length === 0) return null;
  const title = String(offer?.title || '');
  for (const d of rules.discardTitles) {
    if (d.matcher(title)) return d.pattern;
  }
  return null;
}

// ── Near-duplicate collapse (within a batch) ────────────────────────

// Stable identity key: normalized company + sorted role-content tokens.
export function nearDupKey(offer) {
  return `${normalizeCompany(offer?.company)}::${roleTokens(String(offer?.title || '')).sort().join(' ')}`;
}

// Group offers that are the same company + fuzzy-same role; within each group
// keep the best URL (native ATS > company domain > aggregator; tie → first
// seen). Losers are returned in `dropped` with `dupOf` pointing at the
// winner's URL (scan-history status: skipped_dup_near).
export function findNearDups(offers) {
  const groups = [];
  for (const offer of offers) {
    const company = normalizeCompany(offer?.company);
    const title = String(offer?.title || '');
    let group = groups.find(g =>
      g.company === company && g.members.some(m => roleFuzzyMatch(String(m.title || ''), title)));
    if (!group) {
      group = { company, members: [] };
      groups.push(group);
    }
    group.members.push(offer);
  }

  const kept = [];
  const dropped = [];
  for (const group of groups) {
    let winner = group.members[0];
    for (const m of group.members.slice(1)) {
      if (urlSourceRank(m.url) < urlSourceRank(winner.url)) winner = m; // strict < → tie keeps first seen
    }
    kept.push(winner);
    for (const m of group.members) {
      if (m !== winner) dropped.push({ ...m, dupOf: winner.url });
    }
  }
  return { kept, dropped };
}

// ── Fuzzy tracker dedup ─────────────────────────────────────────────

// Catch reposts of an already-evaluated company+role even when the URL and
// exact title differ (e.g. a LinkedIn repost of an evaluated Greenhouse role).
// trackerEntries: [{ company, role }] parsed from applications.md.
// Returns the matched tracker entry, or null (status: skipped_dup_tracker).
export function isFuzzySeenInTracker(offer, trackerEntries) {
  if (!Array.isArray(trackerEntries) || trackerEntries.length === 0) return null;
  const company = normalizeCompany(offer?.company);
  if (!company) return null;
  const title = String(offer?.title || '');
  for (const entry of trackerEntries) {
    if (normalizeCompany(entry?.company) !== company) continue;
    if (roleFuzzyMatch(title, String(entry?.role || ''))) return entry;
  }
  return null;
}

// ── pipeline.md tier layout helpers (pure, line-array level) ────────

export function formatPendingLine(offer) {
  const score = offer?._triage?.score ?? 0;
  return `- [ ] ${offer.url} | ${offer.company} | ${offer.title} <!-- score: ${score} -->`;
}

// Parse a `- [ ] url | company | title` line (optionally score-annotated).
// Returns { url, company, title } with the score comment stripped, or null.
export function parsePendingLine(line) {
  const m = String(line).match(/^- \[ \] (https?:\/\/\S+)\s*\|\s*([^|]*?)\s*\|\s*(.*)$/);
  if (!m) return null;
  const title = m[3].replace(/\s*<!--\s*score:\s*-?\d+\s*-->\s*$/, '').trim();
  return { url: m[1], company: m[2], title };
}

function tierOf(offer) {
  return TIER_MARKER_RE[offer?._triage?.tier] ? offer._triage.tier : 'LOW';
}

function scoreOf(offer) {
  return Number.isFinite(offer?._triage?.score) ? offer._triage.score : 0;
}

function isAnyTierMarker(line) {
  const t = String(line).trim();
  return TIER_ORDER.some(tier => TIER_MARKER_RE[tier].test(t));
}

// Insert ranked offers into an existing Pendientes section body (array of
// lines, heading excluded). Creates tier markers on first use; keeps existing
// entry lines untouched; new offers land under their tier marker positioned
// by descending score relative to already-annotated lines (unannotated lines
// count as -Infinity, so new scored entries go above them).
export function insertOffersIntoPendingLines(lines, offers) {
  const out = lines.slice();

  for (const tier of TIER_ORDER) {
    const tierOffers = offers
      .filter(o => tierOf(o) === tier)
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    if (tierOffers.length === 0) continue;

    let markerIdx = out.findIndex(l => TIER_MARKER_RE[tier].test(l.trim()));
    if (markerIdx === -1) {
      // Create the marker before the first later-tier marker, else at the end
      // of the section (above any trailing blank run).
      let insertAt = -1;
      for (const later of TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1)) {
        const li = out.findIndex(l => TIER_MARKER_RE[later].test(l.trim()));
        if (li !== -1) { insertAt = li; break; }
      }
      if (insertAt === -1) {
        insertAt = out.length;
        while (insertAt > 0 && out[insertAt - 1].trim() === '') insertAt--;
      }
      out.splice(insertAt, 0, TIER_MARKERS[tier]);
      markerIdx = insertAt;
    }

    for (const offer of tierOffers) {
      // Tier block: markerIdx+1 .. next tier marker (or end of section).
      let blockEnd = out.length;
      for (let i = markerIdx + 1; i < out.length; i++) {
        if (isAnyTierMarker(out[i])) { blockEnd = i; break; }
      }
      let insertAt = blockEnd;
      for (let i = markerIdx + 1; i < blockEnd; i++) {
        if (!/^- \[/.test(out[i].trim())) continue;
        const m = out[i].match(/<!--\s*score:\s*(-?\d+)\s*-->/);
        const lineScore = m ? parseInt(m[1], 10) : -Infinity;
        if (lineScore < scoreOf(offer)) { insertAt = i; break; }
      }
      // Don't append below trailing blanks that pad the next marker.
      while (insertAt > markerIdx + 1 && out[insertAt - 1].trim() === '') insertAt--;
      out.splice(insertAt, 0, formatPendingLine(offer));
    }
  }
  return out;
}

// Rebuild a full Pendientes section body (array of lines, heading excluded)
// from scratch — used by --retriage. `preserved` carries non-entry lines
// (e.g. `- [!]` error rows) that must survive the rewrite.
export function buildTieredPendingSection(offers, preserved = []) {
  const lines = [''];
  if (preserved.length > 0) {
    lines.push(...preserved, '');
  }
  for (const tier of TIER_ORDER) {
    lines.push(TIER_MARKERS[tier]);
    const tierOffers = offers
      .filter(o => tierOf(o) === tier)
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    lines.push(...tierOffers.map(formatPendingLine));
    lines.push('');
  }
  return lines;
}
