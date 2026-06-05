#!/usr/bin/env node
/**
 * suggest-portals.mjs — promotion-candidate finder for portals.yml (zero-token).
 *
 * Discovery (LinkedIn parser, site: websearch, scans) keeps surfacing companies
 * that are NOT yet in `tracked_companies`. This script closes the loop: it diffs
 * the companies seen across data/scan-history.tsv, data/pipeline.md, and
 * data/applications.md against the tracked list, and reports the untracked ones
 * you keep seeing — ranked by frequency. When a company's surfacing URL is an ATS
 * board (Greenhouse/Ashby/Lever), it pre-fills a ready-to-paste `api:` entry so the
 * zero-token scanner can monitor it going forward; LinkedIn-surfaced companies are
 * flagged "ATS unknown" for the agent to resolve.
 *
 * Usage:
 *   node suggest-portals.mjs                 # human-readable report
 *   node suggest-portals.mjs --json          # machine-readable (for the agent)
 *   node suggest-portals.mjs --min-count 2   # only companies seen >= N times
 *
 * Pure read-only. Writes nothing — the agent reviews and adds approved entries.
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minCount = (() => {
  const i = args.indexOf('--min-count');
  return i !== -1 ? Math.max(1, parseInt(args[i + 1] || '1', 10) || 1) : 1;
})();

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const SCAN_HISTORY = 'data/scan-history.tsv';
const PIPELINE = 'data/pipeline.md';
const APPLICATIONS = 'data/applications.md';

// ── helpers ─────────────────────────────────────────────────────────
const normName = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// Detect a known ATS board from a job URL → { ats, slug, careersUrl, apiEndpoint }.
function detectAts(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean)[0]; // first path segment = board slug
  if (!seg) return null;
  if (/(^|\.)greenhouse\.io$/.test(host) || /greenhouse\.io$/.test(host)) {
    return { ats: 'greenhouse', slug: seg, careersUrl: `https://job-boards.greenhouse.io/${seg}`, apiEndpoint: `https://boards-api.greenhouse.io/v1/boards/${seg}/jobs` };
  }
  if (host === 'jobs.ashbyhq.com' || host.endsWith('.ashbyhq.com')) {
    return { ats: 'ashby', slug: seg, careersUrl: `https://jobs.ashbyhq.com/${seg}`, apiEndpoint: `https://api.ashbyhq.com/posting-api/job-board/${seg}` };
  }
  if (host === 'jobs.lever.co' || host.endsWith('.lever.co')) {
    return { ats: 'lever', slug: seg, careersUrl: `https://jobs.lever.co/${seg}`, apiEndpoint: `https://api.lever.co/v0/postings/${seg}?mode=json` };
  }
  return null; // unknown ATS (e.g. linkedin.com, company front-end) — resolve manually
}

// ── tracked set ─────────────────────────────────────────────────────
function loadTracked() {
  const names = new Set();
  const slugs = new Set();
  try {
    const cfg = yaml.load(read(PORTALS_PATH)) || {};
    for (const c of cfg.tracked_companies || []) {
      if (c?.name) names.add(normName(c.name));
      // also remember ATS slugs already tracked so we don't re-suggest under an alias
      const ats = detectAts(c.api || c.careers_url || '');
      if (ats?.slug) slugs.add(`${ats.ats}:${ats.slug.toLowerCase()}`);
    }
  } catch (e) {
    if (!asJson) console.error(`⚠️  could not parse ${PORTALS_PATH}: ${e.message}`);
  }
  return { names, slugs };
}

// ── collect seen companies (name -> {display, count, sources, urls}) ─
function bump(map, name, url, source) {
  const key = normName(name);
  if (!key) return;
  if (!map.has(key)) map.set(key, { display: String(name).trim(), count: 0, sources: new Set(), urls: new Set() });
  const e = map.get(key);
  e.count += 1;
  e.sources.add(source);
  if (url) e.urls.add(url);
}

function collectSeen() {
  const map = new Map();

  // scan-history.tsv: url \t first_seen \t portal \t title \t company \t status \t location
  for (const line of read(SCAN_HISTORY).split('\n')) {
    if (!line.startsWith('http')) continue; // skip header/blank
    const c = line.split('\t');
    bump(map, c[4], c[0], 'scan');
  }

  // pipeline.md: "- [ ] <url> | <company> | <title>"  and  "- [x] #N | <url> | <company> | <role> | ..."
  for (const line of read(PIPELINE).split('\n')) {
    let m = line.match(/^- \[ \]\s+(\S+)\s*\|\s*([^|]+)\s*\|/);
    if (m) { bump(map, m[2], m[1], 'inbox'); continue; }
    m = line.match(/^- \[x\]\s+#\S+\s*\|\s*(\S+)\s*\|\s*([^|]+)\s*\|/);
    if (m) bump(map, m[2], m[1], 'inbox');
  }

  // applications.md table: | # | Date | Company | Role | ... (no URL column)
  for (const line of read(APPLICATIONS).split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').map((s) => s.trim());
    // cells: ['', '#', 'Date', 'Company', ...]; skip header/separator rows
    const company = cells[3];
    if (!company || /^company$/i.test(company) || /^-+$/.test(company)) continue;
    bump(map, company, '', 'tracker');
  }

  return map;
}

// ── build candidates ────────────────────────────────────────────────
const { names: trackedNames, slugs: trackedSlugs } = loadTracked();
const seen = collectSeen();

const candidates = [];
for (const [key, e] of seen) {
  if (trackedNames.has(key)) continue; // already tracked
  if (e.count < minCount) continue;

  let ats = null;
  for (const url of e.urls) {
    const d = detectAts(url);
    if (d) { ats = d; break; }
  }
  if (ats && trackedSlugs.has(`${ats.ats}:${ats.slug.toLowerCase()}`)) continue; // tracked under an alias

  const sampleUrl = [...e.urls][0] || '';
  candidates.push({
    company: e.display,
    count: e.count,
    sources: [...e.sources].sort(),
    detectedAts: ats ? ats.ats : null,
    slug: ats ? ats.slug : null,
    careersUrl: ats ? ats.careersUrl : null,
    apiEndpoint: ats ? ats.apiEndpoint : null,
    sampleUrl,
    suggestedEntry: ats
      ? [
          `  - name: ${e.display}`,
          `    careers_url: ${ats.careersUrl}`,
          `    api: ${ats.apiEndpoint}`,
          `    enabled: true`,
          `    notes: "Promoted from discovery (${[...e.sources].sort().join('+')}, seen ${e.count}x)."`,
        ].join('\n')
      : null,
  });
}

candidates.sort((a, b) => b.count - a.count || a.company.localeCompare(b.company));

const ready = candidates.filter((c) => c.apiEndpoint);
const needsLookup = candidates.filter((c) => !c.apiEndpoint);

// ── output ──────────────────────────────────────────────────────────
if (asJson) {
  process.stdout.write(JSON.stringify({
    trackedCount: trackedNames.size,
    seenCount: seen.size,
    minCount,
    readyToAdd: ready,
    needsAtsLookup: needsLookup,
  }, null, 2));
  process.exit(0);
}

console.log(`\n${'='.repeat(64)}`);
console.log(`  portals.yml promotion candidates`);
console.log(`  tracked: ${trackedNames.size} · seen: ${seen.size} · min-count: ${minCount}`);
console.log(`${'='.repeat(64)}\n`);

if (!candidates.length) {
  console.log('No untracked companies found in scan-history / inbox / tracker. 🎉\n');
  process.exit(0);
}

if (ready.length) {
  console.log(`READY TO ADD (ATS board detected — paste under tracked_companies):\n`);
  for (const c of ready) {
    console.log(`  • ${c.company}  [${c.detectedAts}/${c.slug}]  seen ${c.count}x (${c.sources.join('+')})`);
  }
  console.log(`\n  --- suggested YAML ---`);
  for (const c of ready) console.log(c.suggestedEntry + '\n');
}

if (needsLookup.length) {
  console.log(`\nNEEDS ATS LOOKUP (surfaced w/o an ATS URL — e.g. via LinkedIn; agent should find the board):\n`);
  for (const c of needsLookup) {
    console.log(`  • ${c.company}  seen ${c.count}x (${c.sources.join('+')})${c.sampleUrl ? `  e.g. ${c.sampleUrl}` : ''}`);
  }
}

console.log(`\nNext: review the fits, verify each ATS endpoint, and add approved entries to`);
console.log(`${PORTALS_PATH} → tracked_companies. (This script writes nothing.)\n`);
