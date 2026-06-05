#!/usr/bin/env node
/**
 * linkedin-jobs.mjs — LinkedIn job DISCOVERY parser for the career-ops scanner.
 *
 * The zero-token scanner (scan.mjs) is API/HTTP-based and only reaches companies
 * with a detectable ATS (Greenhouse/Ashby/Lever/...). LinkedIn has no such API.
 * This local_parser fills that gap by querying LinkedIn's PUBLIC guest job-search
 * endpoint and emitting jobs-json-v1 that scan.mjs filters (title/location) and
 * dedups like any other source. It DISCOVERS postings; reading each JD is still
 * the pipeline's job (crawl4ai linkedin profile → /jobs/view).
 *
 * Wire it up in portals.yml as a local_parser (see templates/portals.example.yml):
 *   parser:
 *     command: node
 *     script: scripts/parsers/linkedin-jobs.mjs
 *     args: [--keywords, "AI Solutions Architect", --location, "United States", --pages, "2"]
 *
 * Output (stdout): { "jobs": [ { title, url, company, location } ] }   (jobs-json-v1)
 *
 * Notes:
 *  - Endpoint: /jobs-guest/jobs/api/seeMoreJobPostings/search (server-rendered HTML
 *    cards, no JS). Largely public; a logged-in session cookie mainly avoids
 *    throttling. We reuse the cookie file managed by `crawl4ai-cookies import linkedin`
 *    (~/.config/crawl4ai/cookies/linkedin.json) if present — read here, never printed.
 *  - LinkedIn's ToS restricts automated access and it rate-limits/challenges
 *    aggressively. This stays conservative (few pages, sequential, polite delay) and
 *    degrades gracefully (emits {jobs:[]} + a stderr note) on a non-200 / challenge.
 *  - Must finish inside the local-parser budget (20s / 2MB). Defaults respect that.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { keywords: '', location: '', pages: 2, cookies: '', delayMs: 350, timeoutMs: 7000, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--keywords') out.keywords = next() || '';
    else if (a === '--location') out.location = next() || '';
    else if (a === '--pages') out.pages = Math.max(1, Math.min(10, parseInt(next() || '2', 10) || 2));
    else if (a === '--cookies') out.cookies = next() || '';
    else if (a === '--delay-ms') out.delayMs = Math.max(0, parseInt(next() || '350', 10) || 0);
    else if (a === '--timeout-ms') out.timeoutMs = Math.max(1000, parseInt(next() || '7000', 10) || 7000);
    else if (a === '--debug') out.debug = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dbg = (...m) => { if (args.debug) console.error('[linkedin-jobs]', ...m); };

if (!args.keywords.trim()) {
  // No keywords → nothing to search. Emit empty rather than erroring (scan.mjs tolerant).
  console.error('[linkedin-jobs] no --keywords given; emitting empty result');
  process.stdout.write(JSON.stringify({ jobs: [] }));
  process.exit(0);
}

// ── cookie header (optional; reused from crawl4ai's managed jar) ─────
function buildCookieHeader(explicitPath) {
  const p = explicitPath || path.join(homedir(), '.config', 'crawl4ai', 'cookies', 'linkedin.json');
  try {
    if (!existsSync(p)) { dbg('no cookie file at', p, '(continuing anonymously)'); return ''; }
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const jar = Array.isArray(data) ? data : (data.cookies || []);
    const header = jar
      .filter((c) => c && c.name && c.value != null)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    dbg('loaded', jar.length, 'cookies from', p);
    return header;
  } catch (e) {
    dbg('cookie load failed:', e && e.message, '(continuing anonymously)');
    return '';
  }
}

const COOKIE_HEADER = buildCookieHeader(args.cookies);

// ── html helpers (zero-dep) ─────────────────────────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
}
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function firstGroup(re, hay) {
  const m = re.exec(hay);
  return m ? m[1] : '';
}

// Parse the guest endpoint's <li> job cards out of an HTML fragment.
function parseCards(html) {
  const jobs = [];
  // Each card carries data-entity-urn="urn:li:jobPosting:<id>". Use those as anchors.
  const urn = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  const anchors = [];
  let m;
  while ((m = urn.exec(html)) !== null) anchors.push({ id: m[1], idx: m.index });
  dbg('found', anchors.length, 'card anchors');
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].idx;
    const end = i + 1 < anchors.length ? anchors[i + 1].idx : html.length;
    const card = html.slice(start, end);
    const id = anchors[i].id;
    const title = stripTags(firstGroup(/base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/, card));
    const company = stripTags(firstGroup(/base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/, card));
    const location = stripTags(firstGroup(/job-search-card__location"[^>]*>([\s\S]*?)<\/span>/, card));
    if (!title || !id) continue;
    jobs.push({
      title,
      url: `https://www.linkedin.com/jobs/view/${id}`, // canonical, tracking params stripped
      company,
      location,
    });
  }
  return jobs;
}

// ── fetch ───────────────────────────────────────────────────────────
function buildSearchUrl(start) {
  const u = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  u.searchParams.set('keywords', args.keywords);
  if (args.location.trim()) u.searchParams.set('location', args.location);
  u.searchParams.set('start', String(start));
  return u.href;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), args.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.linkedin.com/jobs',
        ...(COOKIE_HEADER ? { Cookie: COOKIE_HEADER } : {}),
      },
    });
    if (!res.ok) { dbg('HTTP', res.status, 'for', url); return { ok: false, status: res.status, html: '' }; }
    return { ok: true, status: 200, html: await res.text() };
  } catch (e) {
    dbg('fetch error:', e && e.message);
    return { ok: false, status: 0, html: '' };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── main ────────────────────────────────────────────────────────────
async function main() {
  const seen = new Set();
  const all = [];
  let blocked = false;
  for (let p = 0; p < args.pages; p++) {
    const url = buildSearchUrl(p * 10);
    const { ok, status, html } = await fetchPage(url);
    if (!ok) { blocked = blocked || status === 429 || status === 403 || status === 999; break; }
    const cards = parseCards(html);
    if (cards.length === 0) break; // no more results
    for (const j of cards) {
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      all.push(j);
    }
    if (p + 1 < args.pages) await sleep(args.delayMs);
  }
  if (blocked) console.error('[linkedin-jobs] LinkedIn returned a block/challenge — refresh cookies via `crawl4ai-cookies import linkedin` and retry. Returning what was collected.');
  process.stdout.write(JSON.stringify({ jobs: all }));
}

main().catch((e) => {
  console.error('[linkedin-jobs] fatal:', e && e.message);
  process.stdout.write(JSON.stringify({ jobs: [] })); // never break the scan run
  process.exit(0);
});
