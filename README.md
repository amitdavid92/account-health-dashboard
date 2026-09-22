# Account Health Dashboard

An internal dashboard for CS and Sales: which accounts are healthy, which are at risk, which
conversation to have first, and the evidence behind every verdict.

Built from `accounts.json` and `usage_events.json` as a full pipeline — raw export → normalized
SQLite → API → Next.js UI.

![Demo: filtering the triage queue to At Risk, an account drill-down with its score breakdown expanded, and the chat assistant answering a real question about that account](docs/demo.gif)

📄 **[ANALYSIS.md](ANALYSIS.md)** — what the data contains, the data-quality checks the pipeline
ran, every threshold and why, the severity model, edge cases, assumptions, and open questions.
Written for whoever is reviewing the build, not for the dashboard's own users - the app itself
stays scoped to what a CSM needs on screen.

## Quick start

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
| `npm test` | 57 tests: the scoring model, the edge cases, and a SQL cross-check of the stored results |
| `npm run build` / `npm start` | Production build |

Three pages: **`/`** the triage queue, **`/accounts/[slug]`** the drill-down, and **`/method`** how
the score works - a CSM's own reference for the number on screen, not a build report. Three API
routes (`/api/accounts`, `/api/accounts/[slug]`, `/api/portfolio`) expose the same reads for
external consumers — the pages themselves call `src/lib/db.ts` directly, server-side, so both read
the one stored verdict rather than each computing its own.

Data-quality findings live in [ANALYSIS.md](ANALYSIS.md) rather than as a page in the app - see
"Where things live" below for why.

## What "account health" means here

**Health is computed from product usage and nothing else.** Four measures, 100 points, and three
facts the arithmetic is not allowed to outvote.

| Pillar | Points | Measures |
|---|---|---|
| **Recency** | 30 | Days since the last event |
| **Breadth** | 25 | Distinct users active in the last 30 days |
| **Depth** | 25 | Guides created (×2) and shared in the last 30 days |
| **Consistency** | 20 | Active weeks out of the last 8 |

`Healthy ≥ 75 · Watch 45–74 · At Risk < 45 · No Data when no events were received.`

Three facts cap the tier after the arithmetic, so a strong score can never hide them: **silent for
30+ days → At Risk**, **no guide created or shared in the window → not Healthy**, **one active user
or fewer → not Healthy**. Every point and every cap prints the one sentence it's made of — see
[ANALYSIS.md](ANALYSIS.md) for the full model, the severity derivation, and why ARR and trend are
deliberately kept out of the score.

**Priority is a separate axis.** Health answers "how is the product going"; priority answers "who do
I call first". It is `max(tier weight, floor from the worst risk) × (1 + log₁₀(1 + ARR))` — so a
commercial flag like a plan downgrade never moves the health score, but a Healthy account carrying a
High or Critical risk still lands in the queue instead of sorting to zero. It ranks a worklist; it
is not a churn prediction.

## Assumptions

The ones that would change the answer if they were wrong — full reasoning for each is in
[ANALYSIS.md §12](ANALYSIS.md).

1. `company_name` joins the two files (verified 1:1 on this snapshot).
2. `accounts.json` is the commercial source of truth for plan and ARR.
3. The account, not the workspace, is the unit of health.
4. "Today" is the latest event in the export (2026-09-13), not wall-clock time.
5. `guide_created` and `guide_shared` are the product's core value — the most opinionated call in the model.
6. Absence of events means absence of usage, not a broken pipeline.

## Architecture

| Stage | File | Does |
|---|---|---|
| Raw export | `data/*.json` | Unmodified input |
| Ingest | `scripts/ingest.ts` | Runs the pipeline below, once |
| Normalize | `src/lib/normalize.ts` | Canonicalize, join, validate → `DataQualityReport` (pure) |
| Metrics | `src/lib/metrics.ts` | Per-account metrics (pure) |
| Health | `src/lib/health.ts` | Pillars → score → overrides → tier (pure) |
| Risks | `src/lib/risks.ts` | Risk detection + severity derivation (pure) |
| Store | `src/lib/db.ts` | Writes `data/health.db` — flat columns for filtering, JSON for evidence payloads |
| Serve | `/api/*` → Next.js UI | Reads the stored verdict, never recomputes |

Health is computed once during ingest and stored — the API serves a verdict rather than
recomputing one, so the UI and the database can never drift apart, and `sqlite3 data/health.db`
re-derives every number with plain SQL. Every threshold lives in `src/lib/config.ts` next to the
reason it was chosen, and `/method` renders that file directly. The scoring stages are pure
functions, which is what lets `tests/pipeline.test.ts` cross-check the stored results against a
fresh in-memory run.

## Chat assistant (my own addition, not part of the brief)

The brief asks for four things — a definition of health, a score, an API, and a UI with a
drill-down. This panel is none of them; I added it on my own initiative because it felt like a
natural extension of "ask the data," not because the brief implies a bonus feature.

A panel beside the theme toggle answers questions like *"which accounts are At Risk and why?"*. It
is a small tool-calling loop over the Gemini API, **not a second model of the data**: the four
tools in `src/lib/chat-tools.ts` are read-only wrappers over the same `src/lib/db.ts` the pages
use, so every figure comes from the stored pipeline output. The prose around those figures is
generated and nothing verifies it — the account page stays the authority, and the panel says so.

The whole dashboard works with no key. To enable the panel, get a free key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey):

```bash
cp .env.local.example .env.local   # then paste the key into GEMINI_API_KEY=
```

Without one, the route returns 503 and the panel explains that it is not configured. When the
provider fails, `src/lib/chat-retry.ts` retries only transient statuses (408/429/5xx), at most
twice per question on a budget shared across every tool-call round, bounded by a 45s server
deadline. Failures surface as a plain message with a **Try again** button and never enter the
history sent to the model. `tests/chat-retry.test.ts` covers recovery, budget exhaustion, the
non-retryable case and cancellation.

## Where things live

The app is scoped to what its users - CS and Sales - actually need on screen: a triage queue, a
drill-down with evidence for every verdict, and a reference for how the score works. Anything whose
audience is a reviewer of this build rather than a CSM belongs in a document, not a page: the
data-quality findings, the modelling choices not taken and why, and the assumptions behind them are
all in [ANALYSIS.md](ANALYSIS.md). An earlier version put some of this in the product itself (a
data-quality panel, an extended methodology page); it moved out once the audience for it turned out
to be whoever is reading this repo, not the person using the dashboard day to day.

## What I'd build next for production

1. Fit the thresholds instead of calibrating them, once real renewal outcomes exist.
2. Per-workspace ingestion-freshness monitoring, so a broken pipeline and a churning customer stop looking identical.
3. Persist verdicts on a schedule instead of reconstructing history per request.
4. Close the loop — let CSMs mark a risk acknowledged or wrong, and store it.
5. Scale the data layer to an incremental warehouse job at real volume.

Full reasoning, plus the open product questions: [ANALYSIS.md §13–14](ANALYSIS.md).
