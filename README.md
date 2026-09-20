# Account Health Dashboard

An internal dashboard for CS and Sales: which accounts are healthy, which are at risk, which
conversation to have first, and the evidence behind every verdict.

Built from `accounts.json` and `usage_events.json` as a full pipeline — raw export → normalized
SQLite → API → Next.js UI.

```bash
npm install
npm run dev          # runs the ingest pipeline first, then starts on :3000
```

Node 22.5+ is required (the storage layer uses the built-in `node:sqlite`, so there is no native
build step and no database dependency to install).

| Command | What it does |
|---|---|
| `npm run dev` | Ingests, then serves on `localhost:3000` |
| `npm run ingest` | Rebuilds `data/health.db` and prints the data-quality report |
| `npm test` | 39 tests: the scoring model, the edge cases, and a SQL cross-check of the stored results |
| `npm run build` / `npm start` | Production build |

Four pages: **`/`** the triage queue, **`/accounts/[slug]`** the drill-down,
**`/method`** how the score works, **`/data-quality`** what the pipeline checked and found.

Four API routes remain for external consumers — `/api/accounts`, `/api/accounts/[slug]`,
`/api/portfolio`, `/api/data-quality` — but the pages themselves are Server Components that call
`src/lib/db.ts` directly, server-side, rather than fetching their own API over HTTP. That is a
routing choice, not a data one: `db.ts` is the single read path either way, so the page and the API
can never disagree, and it removes a client-side loading state for what is, on 480 rows, an
instant read.

### The UI layer, and why it looks the way it does

The visual system — sidebar navigation by health tier, the stat-tile row, the triage table with
sortable columns, the health ring, the "why this score" bar list, the event-mix bar, the data-notes
drawer — is a deliberately dense, information-first design: 13px base type, tabular figures
wherever digits sit in a column, and a status palette (`--good`/`--warn`/`--crit`/`--none`) kept
strictly apart from the categorical chart colours, so a tier badge can never be mistaken for a data
series. Every status ships with a distinct glyph as well as its colour — green and amber measure
under 5 ΔE apart under protanopia, so hue alone is not load-bearing anywhere in this UI.

Two things worth knowing about what feeds it:

- **"Biggest drops" is real, not decorative.** `src/lib/history.ts` computes each account's score
  30 days ago by re-running the *same* pure pipeline (`buildSummaries` from `pipeline.ts`) on an
  earlier snapshot, after dropping events that had not happened yet. No score is stored twice and
  no new model exists — it calls the existing, tested code path a second time. `src/lib/db.ts`
  exposes one small read-only accessor (`getRawData`) so this can reconstruct the normalized
  accounts/events without re-parsing the original JSON.
- **The "big accounts below Healthy" callout uses the model's own threshold.** It flags accounts at
  or above the same top-quartile ARR cut (`quantile(arr, SEVERITY_RULES.highValueQuantile)`) that
  the severity engine already uses to escalate risk — one definition of "high value" everywhere,
  not a second opinion invented for the UI.

One note on the wordmark: it ships as a CSS mask, not an image. The supplied asset is red on a
white JPEG, which would render as a white slab in dark mode, so `public/brand/guidde.png` carries
the paper keyed out to transparency — alpha taken from each pixel's distance from white, so the
anti-aliased curves stay smooth — and `Logo.tsx` fills that mask with a dedicated `--brand` token
(`#CC0001`, sampled from the asset, kept separate from the UI's own blue accent). One file, correct
in both themes. The original JPEG is kept beside it as `guidde-source.jpg` so the mask can be
regenerated.

---

## What "account health" means here

**Health is computed from product usage and nothing else.** Four measures, 100 points, and three
facts the arithmetic is not allowed to outvote.

| Pillar | Points | Measures | Why it earns a place |
|---|---|---|---|
| **Recency** | 30 | Days since the last event | The least ambiguous churn signal in this data, and the one with real spread (0–43 days) |
| **Breadth** | 25 | Distinct users active in the last 30 days | Separates a team habit from a single champion — the difference between a renewal and a resignation letter |
| **Depth** | 25 | Guides created (×2) and shared in the last 30 days | Guidde is bought to capture and distribute knowledge. An account that only logs in is not getting what it paid for |
| **Consistency** | 20 | Active weeks out of the last 8 | Counting weeks rather than events keeps this stable at the low volumes in this dataset |

`Healthy ≥ 75 · Watch 45–74 · At Risk < 45 · No Data when no events were received.`

**Every point traces to one sentence a CSM can read.** The drill-down does not interpret the score;
it prints what the score was made of. If someone disagrees with a verdict they can point at the
specific line they think is wrong, which is the only kind of disagreement worth having.

### Three facts the score cannot outvote

A weighted sum can always be outvoted by its other terms — an account that is broad, consistent and
creative can absorb a lost recency pillar and still read Healthy a month after it went quiet. So
these cap the tier *after* the arithmetic, and each states its own reason on the account page:

1. **Silent for 30+ days → At Risk.** A quiet month is not a scoring nuance.
2. **Never created or shared a guide → cannot be Healthy.** Login volume does not change that.
3. **One active user or fewer → cannot be Healthy.** One person is not adoption.

Worth stating plainly: **on this snapshot the caps fire ten times and change the final tier zero
times** — in every case the score had already reached the same verdict. They are not tuned to this
data, and they are not decoration either. The failure mode they close is structural: strip a
thriving account's recency and the other three pillars still carry it past 75, so it reads Healthy
a month after it went silent. `tests/health.test.ts` constructs exactly that account and asserts it
comes back At Risk.

### ARR is deliberately *not* in the score

The first thing the data says is that **ARR correlates negatively with usage** (Pearson −0.21).
The five accounts paying the most generate 64 events between them; the five paying nothing generate
116. **$841,131 of Enterprise ARR — 56% of the entire book — sits in six accounts with fewer than
15 events in 90 days.**

An Enterprise account is not *healthier* for paying more. So health answers "how is the product
going", and a separate **priority** axis — health tier weighted by log-scaled ARR — answers "who do
I call first". Keeping them apart is what lets the dashboard open with **$391,024 of ARR at risk**
instead of "the average score is 81".

### Trend is computed, displayed, and not scored

The median account produces 19 events in 90 days. Comparing 30 days against 30 days on six events
measures sampling noise, not customer behaviour — and an alert that fires on noise destroys a CSM's
trust in the tool faster than no alert at all.

So trend is gated twice: at least **12 events** in the window and a change of at least **50%**. On
this dataset that reports 4 accounts out of 25 rather than 25 flapping arrows. It appears as
evidence and as a risk; it is never worth points.

### Severity is derived, not assigned

```
severity = the signal's own strength
           + 1 level if the account is in the top ARR quartile
           + 1 level if two or more risks fire together
           held at High when every health pillar is strong
```

With two guards: a risk whose definition already contains ARR is not escalated for ARR again, and
**convergence does not escalate on a low-confidence account** — several rules firing on four events
is the same thin evidence counted several times, not several independent signals agreeing.

Each escalation shows its work on the account page. **Redwood Studios and Tidewater Retail are both
dormant and both start at High** — Redwood lands at Critical because $139,800 puts it in the top
quartile, Tidewater stays at High on $0. Same illness, different urgency, and the difference is
stated rather than asserted. **Cedarline Insurance reaches Critical by the other route entirely**:
at $65,656 it is *not* top-quartile, but five independent rules fire on it at once.

---

## What the data actually said

Both files were analysed in full, not sampled. Findings are in
[ANALYSIS.md](ANALYSIS.md); `/data-quality` shows the same report live.

The brief warns the export "wasn't cleaned up". Most of the expected problems **are not there** —
no missing fields, no duplicate event IDs, no orphan events, no accounts without events, and the
company names join 1:1 between the files. Saying that with the checks that prove it is more useful
than inventing problems, so all 12 checks are shown, passing ones included.

Three things are genuinely worth handling:

| Finding | Decision |
|---|---|
| **3 accounts run 2 workspaces each** (Alderman Freight, Brightside Logistics, Cobalt Financial), with fully disjoint user sets | Health is scored per account with workspaces rolled up and users deduplicated. The drill-down shows the per-workspace split so a half-adopted second team is visible |
| **2 accounts show a plan downgrade mid-window** (Marlowe & Reed, Thistle & Vine: Enterprise in the contract, Pro on their latest events) | `accounts.json` stays the source of truth for plan and ARR. The drift is surfaced as a commercial risk flag — real signal, but not usage, so it never touches the score |
| **No events exist between 09:00 and 19:00 UTC**, across all 90 days | An artifact of how the sample was generated. Recorded as a hard limitation: no hour-of-day or day-of-week analysis is built anywhere, because that distribution is not real |

### Deliberately not built

- **Total event count as a KPI** — it rewards noise, and in this portfolio the noisiest accounts are the ones worth $0.
- **Per-user engagement scores** — 186 users produce between 1 and 8 events each. Users are counted, not ranked.
- **Onboarding-cohort analysis** — every account's contract predates the window, so no account's first 90 days are visible.
- **Any chart the data cannot support**, per the timestamp artifact above.

---

## Assumptions

1. **`company_name` joins the two files.** Verified exactly 1:1 on this snapshot. The join still runs through a canonicalization step (case, whitespace, punctuation, legal suffixes) so the assumption is explicit and a fuzzy matcher can replace it in one place.
2. **`accounts.json` is the commercial source of truth** for plan and ARR. `plan_tier` on an event is historical state; disagreement is surfaced, never silently resolved.
3. **The account is the unit of health.** Workspaces roll up; users are deduplicated across them (unnecessary on this data, where the sets are disjoint, but the code does it anyway).
4. **"Today" is the latest event timestamp (2026-09-13), not wall-clock time.** Otherwise every account would drift into dormancy and the demo would rot.
5. **The 90-day window is all the history there is.** Trend is strictly within-window; there is no pre-window baseline to compare against.
6. **`guide_created` and `guide_shared` are the product's core value.** This is the most product-opinionated assumption in the model and the one most worth challenging — it is what makes Cedarline Insurance At Risk despite a healthy-looking event count.
7. **Absence of events means absence of usage, not a broken pipeline.** Untestable from a single snapshot, which is why a zero-event account is `No Data` rather than `At Risk`.

## Open questions (product decisions, not data ones)

1. Should a **Free** account be scored on the same axis as an Enterprise one, or is "health" for a free account really conversion likelihood? The four highest-usage accounts here are free and worth $0.
2. Is `guide_viewed` value delivered (an audience exists) or noise (one person scrolling)? It is 34% of all events and the Depth pillar currently ignores it.
3. What is the real churn window? These thresholds are **calibrated** to split this portfolio usefully. With historical churn outcomes they would be **fitted** instead.
4. Should CSM ownership feed priority? The data supports it — four CSMs hold 5–7 accounts each, very unevenly distributed by ARR.

---

## Architecture

```
data/*.json          the raw export, unmodified
  ↓ scripts/ingest.ts
src/lib/normalize.ts canonicalize, join, validate → DataQualityReport
src/lib/metrics.ts   per-account metrics          (pure)
src/lib/health.ts    pillars → score → overrides → tier  (pure)
src/lib/risks.ts     risk detection + severity derivation (pure)
  ↓ src/lib/db.ts
data/health.db       SQLite: flat columns for filtering, JSON for evidence payloads
  ↓
/api/*  →  Next.js UI
```

Three decisions worth naming:

- **Health is computed once during ingest and stored**, so the API serves a verdict rather than recomputing one. What the UI shows and what the database holds cannot drift apart, and `sqlite3 data/health.db` lets you re-derive every number in the UI with plain SQL.
- **Every threshold lives in `src/lib/config.ts`** with the reason next to it. Nothing downstream hard-codes a number, and `/method` renders that file directly — so the documented model cannot fall out of step with the computed one.
- **The scoring stages are pure functions.** That is what makes the model testable without a database, and what lets `tests/pipeline.test.ts` cross-check the stored results against a fresh in-memory run.

## What I'd build next for production

1. **Fit the thresholds instead of calibrating them.** Everything here is a defensible guess. With 12 months of renewal outcomes, the bands become a logistic fit and the pillars get weights that mean something — while keeping the "score = sum of stated reasons" contract, which is the part worth protecting.
2. **Ingestion-freshness monitoring per workspace.** Assumption 7 is the dangerous one: today a broken pipeline and a churning customer look identical. A per-workspace last-seen heartbeat separates them before a CSM makes a call based on silence that was ours, not theirs.
3. **Track verdict changes over time.** The UI's "score 30 days ago" comparison (`src/lib/history.ts`) gets there today by re-running the pipeline on an earlier snapshot on every request — a fine trick for one comparison point on 480 events, and not how this should work at real volume or for more than two points in time. The single most useful thing a CSM wants and a re-run can't give: *"three accounts dropped out of Healthy this week."* That needs the pipeline to run on a schedule and persist each verdict, not recompute history live.
4. **Close the loop.** Let CSMs mark a risk as acknowledged or wrong, and store it. Those annotations are both the UX fix for false positives and the labelled training data that step 1 needs.
5. **Scale the data layer.** SQLite and a full rebuild are right for 480 events and honest about it. At real volume this becomes an incremental warehouse job with the same stage boundaries — the pure functions move; nothing else about the model has to.
