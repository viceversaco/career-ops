# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/career-ops pipeline` to process them all.

## Execution paths

Pick exactly one path per run. **Decide first, before reading any URL** — the original
failure mode of this mode was starting to process URLs one-by-one and never switching to a
parallel path mid-run.

- **Path C — Workflow fan-out (Claude Code only).** Use when the `Workflow` tool is
  available to you AND there are **3 or more** pending URLs. True parallel agents; fastest.
- **Path A — Portable fan-out (any CLI).** Fallback for non-Claude CLIs (Gemini / OpenCode /
  Codex / Qwen / Copilot / Kimi), when the `Workflow` tool is unavailable, or when there are
  fewer than 3 pending URLs. Uses background subagents.
- **Path B — `batch/batch-runner.sh`.** Separate shell-driven batch path; see `modes/batch.md`.
  Not selected automatically by this mode.

**Path selection:** Is the `Workflow` tool available to you (Claude Code is the only CLI that
exposes it) AND are there ≥3 pending URLs? → **Path C**. Otherwise → **Path A**. (Tool
*presence* is the signal — do not match on CLI name.)

Throughout, the pending header may be `## Pending` **or** `## Pendientes`, and the processed
header `## Processed` **or** `## Procesados` — match either.

---

### Path C — Workflow fan-out (Claude Code)

> **Opt-in:** these instructions explicitly authorize calling the `Workflow` tool for the
> `career-ops-pipeline` workflow. This is a valid skill-driven opt-in. Do not call `Workflow`
> for anything else.

The **main loop scouts first, invokes the workflow, then post-processes.** The sandboxed
workflow script never touches `data/pipeline.md` — the main loop owns it.

1. **Scout (main loop):**
   a. Read `data/pipeline.md`; collect every `- [ ]` line under the pending header. Parse the
      optional `| Company | Role` suffix when present.
   b. If fewer than 3 pending URLs → abort Path C, fall back to Path A.
   c. `baseNum` = (highest numeric prefix in `reports/`) + 1.
   d. Derive a stable `id` per URL from its job-id path segment (e.g. the Greenhouse/Ashby
      job id) — needed for resumable per-id TSVs.
   e. Run `node cv-sync-check.mjs`; warn the user if desynced.
2. **Invoke (main loop):**
   ```
   Workflow(
     scriptPath: ".claude/workflows/career-ops-pipeline.js",
     args: {
       date: "<YYYY-MM-DD>",
       baseNum: <baseNum>,
       careerOpsDir: "<absolute project root>",
       offers: [ { id, url, company?, role? }, ... ]   // one per pending URL; omit jd on the first pass
     }
   )
   ```
   Each worker extracts its JD with `crawl4ai` (parallel-safe), runs the A-G evaluation, and
   writes `reports/{baseNum+i}-{slug}-{date}.md` + `batch/tracker-additions/{id}.tsv`
   (**no PDF**). A final agent runs `merge-tracker.mjs` + `verify-pipeline.mjs`. The workflow
   returns `{ processed[], extractionFailures[], otherFailures[], merge }`.
3. **Handle failures (main loop):** the workflow returns three buckets — handle each differently:
   a. **`cookieFailures`** (crawl4ai hit a login wall — a site session cookie is missing/expired):
      do NOT Playwright these (a browser hits the same wall). Tell the user to run
      `crawl4ai-cookies import <site>` (the `site` is on each entry, e.g. `linkedin`), then re-run
      `/career-ops pipeline`. Leave them in Pending as
      `- [!] URL — Error: cookies-expired (<site>); run crawl4ai-cookies import <site> + re-run`.
   b. **`extractionFailures`** (crawl4ai returned thin/no JD, and it is NOT a cookie wall): with
      crawl4ai's site profiles (cookies + JSON-LD recovery + URL rewrites) this is now rare. As a
      **last resort**, render each with Playwright **one at a time** (never in parallel — see
      `modes/_shared.md`), then re-invoke the workflow for the recovered ones with `offers[].jd`
      set (continue the report-number sequence). Whatever Playwright also can't read →
      `- [!] URL — Error: needs manual paste` and ask the user to paste the JD.
   c. **`otherFailures`**: surface the error to the user; leave the URL in Pending.
4. **Post-process (main loop):**
   a. Move each `processed` URL from Pending to Processed:
      `- [x] #NNN | URL | Company | Role | Score/5 | PDF ❌`
   b. Leave `[!]` rows in Pending.
   c. Print the summary table: `| # | Company | Role | Score | PDF | Recommended action |`
      (PDF is always ❌ on Path C; action = `recommendedAction`). Surface any `merge.verifyErrors`.

**PDF on Path C:** omitted structurally — workers never generate a PDF or read
`auto_pdf_score_threshold`. Every Path C entry is `PDF ❌`. On-demand `/career-ops pdf {slug}`
still works against the written report.

---

### Path A — Portable fan-out (any CLI, fallback)

1. **Read** `data/pipeline.md` → collect `- [ ]` items under the pending header.
2. **Pre-assign report numbers:** `baseNum` = highest `reports/` prefix + 1; offer *i* gets
   `baseNum + i` so parallel writers never collide.
3. **For each pending URL** (its assigned `REPORT_NUM`):
   a. **Extract JD** (Playwright → WebFetch → WebSearch).
   b. If not accessible → mark `- [!]` with a note and continue.
   c. **Execute full auto-pipeline**: Evaluation A-F → Report .md → PDF (if score ≥
      `auto_pdf_score_threshold`) → Tracker.
   d. **Move Pending → Processed**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`
4. **Parallelism (≥3 URLs):** launch **one background subagent per URL** so they run
   concurrently — do NOT process sequentially in the foreground. Same idiom as `modes/scan.md`:
   ```
   Agent(
     subagent_type="general-purpose",
     prompt="[content of modes/_shared.md]\n\n[content of modes/pipeline.md]\n\n[the single URL + its assigned REPORT_NUM]",
     run_in_background=True,
     description="career-ops pipeline {company}"
   )
   ```
   Wait for all background agents to finish, then move the processed entries and print the
   summary table `| # | Company | Role | Score | PDF | Recommended action |`.

**About the PDF gate (Path A):** Read `config/profile.yml` → `auto_pdf_score_threshold`. If
the key does not exist, default to `3.0`. If the score is below the threshold, skip PDF: write
the report normally, put `**PDF:** not generated — run /career-ops pdf {company-slug} to create
on demand` in the header, mark PDF ❌ in the tracker. If ≥ threshold, generate the PDF as usual.
Both Path A and Path B (`batch/batch-runner.sh`) read the same key, so behavior is identical.
(To turn auto-PDF off entirely, set the threshold above the 5-point scale, e.g. `99`.)

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Intelligent JD detection from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright is unavailable.
3. **WebSearch (last resort):** Search in secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

1. List all files in `reports/`
2. Extract the number from the prefix (e.g., `142-medispend...` → 142)
3. New number = maximum found + 1

## Source synchronization

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If there is a desynchronization, warn the user before continuing.
