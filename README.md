# Account Health Dashboard

An internal dashboard for CS and Sales: which customer accounts are healthy,
which are at risk, and — the part that matters — **why**.

Built end to end: a data layer that computes health from raw product events, an
API that serves it, and a UI a CSM can open and act on.

---

## Setup

Requires Node 20.9+ (Next.js 16 minimum).

```bash
npm install
npm run dev            # http://localhost:3000
```

Other scripts:

```bash
npm run build          # production build
npm run lint           # ESLint
npm run calibrate      # print the distribution of every health input (see Calibration)
npm run generate:data  # regenerate the sample export in data/
```

### Using the real export

The exercise's two files were not attached to the repo I was given, so `data/`
holds a **generated stand-in** with the same schema and the same deliberate
messiness. To use the real thing:

```bash
cp /path/to/usage_events.json /path/to/accounts.json data/
rm scripts/generate-sample-data.mjs     # nothing in src/ imports it
npm run calibrate                       # then update TARGETS in src/lib/health.ts
npm run dev
```

Nothing in `src/` knows the data is synthetic — the pipeline reads
`data/usage_events.json` and `data/accounts.json` and computes everything from
the raw events.

---

## What "account health" means here

Health answers one question: **is this account building a habit around the
product, or drifting away from it?**

Six inputs, each normalised to 0–100 against a "what good looks like" target,
combined with fixed weights that sum to 1:

| Input | Weight | Measures | Why it's weighted that way |
|---|---|---|---|
| **Guide creation** | 30% | `guide_created` in 30d per known seat, log-scaled | The core value action, and the hardest to fake |
| **Adoption breadth** | 20% | share of known users active in 30d | Separates one champion from a team habit — the best predictor that usage survives one person leaving |
| **Value realisation** | 20% | `guide_viewed` in 30d per guide in the library | Guides nobody watches are effort without payoff |
| **Collaboration** | 10% | `guide_shared` + `user_invited` per 10 active users | Footprint signal that precedes seat expansion |
| **Momentum** | 10% | trailing 30d activity ÷ prior 30d | Direction of travel, not level. Flat scores 50 by design |
| **Recency** | 10% | days since last `guide_created`, zero at 30d | Keyed to creation, not logins — people keep logging in after they stop getting value |

**Bands:** Healthy ≥ 70 · Watch 40–69 · At risk < 40 · **No signal** (held out).

Because the weights sum to 1, **the score is exactly the sum of the
contributions shown in the drill-down**. The explanation can never drift from
the number — that's enforced by construction, not by keeping two code paths in
sync.

The 30-day delta is computed by running the *same* function over a window
ending 30 days earlier, so the change on screen is apples to apples.

### Two metric definitions I had to fix

Both of these scored a dying account as healthy, and both are worth knowing
about because the naïve version is the one you'd write first:

1. **Creation per *active* seat scored Kestrel Labs 100/100** while its creation
   had collapsed 85%. Its team had walked away, so the denominator collapsed
   with it and the ratio looked great. Now divided by **known** seats — losing
   your team costs you the score, which is the behaviour we want to detect.

2. **Views per guide *created* scored Petra Civil 96/100** while it was dying.
   Creation had stopped, so the denominator went to near-zero and the ratio
   soared. Now measured as views per guide **in the library**, which falls when
   consumption falls and can't be flattered by creation stopping.

### Calibration

`TARGETS` in `src/lib/health.ts` are **calibrated to the observed distribution**
(roughly its 80th percentile), not guessed. My first pass guessed them and every
target landed below the book's p80, so five of six inputs saturated at 100 for
most accounts and the score stopped discriminating at the top — a book where 10
of 14 accounts were "Healthy" with a median of 91.

`npm run calibrate` prints the p10/p50/p80/p90 of every raw input. Re-run it
against the real export and move the targets to the p80 column.

Absolute-with-calibration rather than pure percentile scoring, deliberately:
percentiles guarantee somebody is always "at risk" even when every account is
thriving, which would send a CSM chasing a healthy customer.

---

## Assumptions and judgement calls

Every one of these is also surfaced **in the UI**, behind the ⚠ button — the
people who need them are looking at the dashboard, not this file. `GET
/api/data-quality` returns the same list.

**Identity**
- `company_name` is not a clean 1:1 with `workspace_id`. Events are rolled up
  per account by normalising the name (case, punctuation, `Inc`/`Ltd`/`Group`
  suffixes) and falling back to the **domain stem** from `accounts.json`. Orcus
  Retail Group arrives three ways — "Orcus Retail Group", "Orcus Retail Grp.",
  "ORCUS RETAIL GROUP" — and is one account with three workspaces.
- Normalisation is for *matching only*. The display name always comes from
  `accounts.json`, the commercial source of truth.
- A workspace with events but **no account row** (`ws_8841`) is excluded from
  every score and surfaced as unmapped, with its event count. It's either a
  missing account row or a churned workspace; both need a human, and silently
  dropping it would hide revenue.

**Absence of data**
- An account with **zero events** is `No signal`, never scored 0. An account we
  cannot see is a different problem from an account in trouble, and a zero would
  rank it *above* genuinely failing accounts in a triage queue.
- An account whose stream **stops dead mid-window** is held out as a suspected
  ingestion gap, not scored as churn. The test is shape, not silence: real churn
  decays, so a clean cut after running at ≥3 events/day is treated as a pipeline
  problem. Mint Hill Schools goes from 7.1 events/day to zero overnight and
  stays there 49 days — that gets a pipeline check, not a phone call.
- Genuine dormancy still scores. Petra Civil has stopped *creating* for 50 days
  but is still producing events, so it's scored, and recency floors at 0.

**Time**
- The window is anchored to the **most recent event in the export**, not to
  wall-clock today. Otherwise every account silently re-bands as the file ages.
  The snapshot date is shown in the sidebar.
- Momentum compares **whole 30-day windows**. Every account drops ~two thirds at
  weekends; day-over-day comparison would read that as decline.

**Plan tier**
- `plan_tier` on an event is as-of-event and drifts from `accounts.json`. The
  account row is current truth; the mid-window change is kept as a timeline
  signal (Thornbury Media went Free → Pro on day 34).

**Small numbers**
- Accounts under 150 events or 6 known users are scored but flagged **low
  volume**, because one person's fortnight off swings them 20 points. Shown with
  a caveat rather than hidden — a CSM would rather have a shaky number labelled
  as shaky than no number.

---

## Architecture

```
data/                         the export (raw events + account rows)
src/lib/
  types.ts                    shared contracts
  health.ts                   the model: targets, weights, bands, eligibility
  pipeline.ts                 identity resolution, bucketing, metrics, data quality
  service.ts                  memoised book, query/filter/sort  ← single source of truth
src/app/api/
  accounts/                   GET list (the triage queue contract)
  accounts/[slug]/            GET drill-down (score + every input + evidence)
  summary/                    GET book roll-up + the model definition itself
  data-quality/               GET every judgement call the pipeline made
src/app/
  page.tsx                    overview: tiles, distribution, movers, triage queue
  accounts/[slug]/page.tsx    drill-down: ring, decomposition, trend, workspaces
src/components/               presentational pieces + the three client islands
scripts/
  generate-sample-data.mjs    the stand-in export
  calibrate-targets.mjs       target calibration
```

### Why the UI doesn't fetch its own API

The server components import `src/lib/service.ts` **directly**; they don't HTTP
back into `/api/*`. A server component calling its own route handler is a
network round-trip to itself, and Next.js recommends against it. The route
handlers and the pages both call the same service module, so the API and the UI
cannot disagree about a number.

The API isn't decoration — it's the contract for everything that isn't this UI
(a Slack digest, a Looker extract, a CSM's spreadsheet), and the **query string
is shared verbatim** with the UI's URL state. Any view in the dashboard is
reproducible as an API call:

```bash
# the triage queue, worst first
curl 'localhost:3000/api/accounts?sort=score&dir=asc'

# everything below Healthy, biggest contract first
curl 'localhost:3000/api/accounts?band=crit,warn&sort=arr&dir=desc'

# one account's full decomposition
curl 'localhost:3000/api/accounts/kestrel-labs' | jq '.health.inputs'

# the model definition, so a consumer need not hardcode the weights
curl 'localhost:3000/api/summary' | jq '.model'

# every messy-data call, with the rule behind it
curl 'localhost:3000/api/data-quality' | jq '.notes[].rule'
```

Filters live in the **URL**, applied server-side. A CSM can bookmark "my at-risk
Enterprise accounts" and it works without JavaScript. Only three things are
client components: the theme toggle, the data-notes drawer, and the trend
chart's hover layer.

---

## UI decisions worth defending

- **The queue is sorted worst-first by default.** It's a triage tool, not a
  report.
- **ARR below Healthy is the headline**, not account count. It's the number CS
  and Sales leadership actually act on, and it's robust to exactly where the
  Watch/At-risk threshold sits.
- **Every band shows a label, a glyph and the number** — colour is redundant
  reinforcement, never the channel carrying meaning. Green and amber are
  near-indistinguishable under protanopia (CVD ΔE 4.7, measured), so a
  green/amber/red scale cannot carry state on hue alone.
- **Status colours have separate mark and text steps**, because the mark colours
  don't clear 4.5:1 as text on their own surface. All text pairs verified.
- **Sparklines are weekly buckets, not daily.** 90 points inside 68px is noise,
  and the weekend trough would read as a dip it isn't.
- Light and dark are both designed, and the theme follows the OS unless the
  viewer overrides it.

---

## What I'd build next for production

**Make it real data, not a file**
1. The snapshot is a JSON file read into memory. Replace `loadRaw()` with a
   warehouse query — the seam is one function, and nothing above it changes.
2. Precompute daily health per account in the warehouse (dbt model, one row per
   account per day) instead of recomputing 90 days on every boot. The trend then
   becomes a real score history rather than a two-point delta, and "score 30 days
   ago" stops being a recomputation.
3. Incremental ingestion with a freshness check, so the "suspected ingestion
   gap" rule becomes a monitored SLA rather than a heuristic the dashboard
   infers.

**Make the model trustworthy**
4. **Back-test against actual churn and expansion.** Right now the weights are
   reasoned, not validated. With 12 months of renewals I'd fit them — or at
   minimum measure whether At-risk actually predicts churn better than chance.
   That's the single biggest gap between this and something leadership should
   act on.
5. Per-plan-tier and per-segment calibration. An Enterprise account creating 3
   guides a month is in trouble; a 4-seat Free trial doing the same is fine. One
   set of targets for the whole book is a simplification.
6. Track score history so "dropped 25 points" is read off a stored series, and
   alert on the *change* rather than the level — a healthy account falling fast
   matters more than a stably mediocre one.

**Make it usable at scale**
7. Filtering and sorting move server-side with pagination and a real index; the
   current in-memory pass is fine at 16 accounts and wrong at 10,000.
8. Auth and row-level scoping, so a CSM sees their book by default.
9. Write-back: acknowledge a signal, snooze an account, log an outreach — a
   triage queue that can't be triaged gets stale.
10. Tests. The scoring functions are pure and table-test-shaped; the two metric
    bugs above would both have been caught by a fixture asserting "an account
    whose team leaves must not score 100 on creation". I'd add those first.
