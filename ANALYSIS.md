# Analysis

What the two exports actually contain, what is wrong with them, which signals they support, and how
that led to the health model. Both files were read in full — 25 accounts and 480 events, not a
sample. Every figure here is reproduced by `npm run ingest` and asserted in `tests/pipeline.test.ts`,
so this document cannot quietly go stale.

---

## 1. The dataset

| | |
|---|---|
| Accounts | 25 |
| Events | 480 |
| Companies in the event stream | 25 — the identical set to `accounts.json` |
| Workspaces | 28 |
| Distinct users | 186 |
| Window | 2026-06-16 → 2026-09-13 (89 days) |
| Plans | Pro 10, Enterprise 9, Free 6 |
| Events | guide_viewed 161 · login 119 · guide_created 81 · guide_shared 72 · user_invited 47 |
| Total ARR | $1,494,469 |
| Events per account | min 3 · median 19 · max 40 |
| Events per user | min 1 · max 8 (54 users have exactly one) |

Two facts here shape everything downstream.

**The dataset is small.** A median of 19 events over 90 days is one event every 4.7 days. Any
statistic built on a subdivision of that — a 30-day slice, a week-over-week rate, a per-user
average — is being computed on single digits.

**Global volume is flat.** Weekly totals across the whole portfolio run 27–45 with no direction, and
only one of the 90 days has no events at all. There is no product-wide trend, so any per-account
decline is either specific to that account or it is noise. That is the question the trend gate in
§5 exists to answer.

---

## 2. Data quality

The brief warns the export "wasn't cleaned up". It is worth stating plainly: **most of the expected
problems are not present.** All twelve checks are reported — including the eight that came back
clean — because "no duplicates were found" and "duplicates were never looked for" are very different
statements about a dataset, and only one of them earns trust in the numbers built on top.

| # | Check | Result | Decision |
|---|---|---|---|
| 1 | Missing or malformed fields | **0** in either file | Verified, not assumed |
| 2 | Duplicate `event_id` | **0** | Verified |
| 3 | Replayed rows (same workspace + user + type + timestamp, new id) | **0** | Verified; the dedup runs anyway, since an export replay must never inflate an account |
| 4 | Company names across the two files | **Exact 1:1**, 25↔25, no case, whitespace, punctuation or legal-suffix variants | Joined on a canonical key rather than the raw string, so the assumption is explicit and swappable for fuzzy matching in one place |
| 5 | Accounts with no events | **0** — the quietest has 3 | The zero-event path is still implemented; see §8 |
| 6 | Events with no matching account | **0** | Orphan handling still implemented and reported |
| 7 | Workspaces claimed by two companies | **0** | Mapping is unambiguous |
| 8 | Users appearing under two accounts | **0** | Distinct-user counts per account are safe |
| 9 | Timestamps | All parse as ISO-8601 UTC, all inside the window, none in the future | "Today" pinned to the latest event, never the clock |
| 10 | **Accounts with more than one workspace** | **3** — Alderman Freight (17+18), Brightside Logistics (21+15), Cobalt Financial (29+11). **User sets fully disjoint** — no person appears in both | Roll up to the account, deduplicate users, show the split in the drill-down |
| 11 | **`plan_tier` drift between the files** | **2** — Marlowe & Reed and Thistle & Vine Events are Enterprise in `accounts.json` but Pro on their most recent events | See below |
| 12 | **Hour-of-day distribution** | **No events at all between 09:00 and 19:00 UTC**, across all 90 days | See below |

### On the plan drift (#11)

Ordering the events chronologically settles it: both accounts show Enterprise events first and Pro
events only at the end of the window. These are **downgrades that happened**, not export noise.

The decision: `accounts.json` remains the source of truth for the displayed plan and ARR, the event
stream is treated as plan history, and the disagreement is raised as a **commercial risk flag**. It
is genuine signal — a customer who downsized mid-quarter is a fact a CSM should never be surprised
by — but it is not *usage*, so it never touches the health score. Thistle & Vine is Healthy on every
usage measure and still carries a High plan-downgrade flag; both statements are true and the
dashboard shows both.

### On the timestamp artifact (#12)

Activity is confined to 19:00–09:00 UTC on every one of the 90 days. No real customer base produces
that; it is an artifact of how the sample was generated.

The consequence is a hard constraint, not a footnote: **no hour-of-day or day-of-week analysis is
built anywhere in this dashboard.** The data would happily support a "peak usage hours" chart. It
would be a chart of the generator, not of the customers. Daily and weekly aggregates are unaffected.

---

## 3. The finding that motivates the dashboard

**ARR correlates negatively with product usage.** Pearson −0.21, Spearman −0.19.

| | ARR | Events (90d) | Users | Days silent |
|---|---|---|---|---|
| Cobalt Financial (Free) | **$0** | **40** | 12 | 2 |
| Alderman Freight (Free) | **$0** | **35** | 11 | 4 |
| Quarrystone Consulting (Ent.) | $218,346 | 32 | 10 | 1 |
| Thistle & Vine Events (Ent.) | $197,969 | **10** | 7 | 3 |
| Pinnacle Manufacturing (Ent.) | $185,568 | **4** | 2 | 21 |
| Fernhill Energy (Ent.) | $165,285 | 13 | 4 | 4 |
| Redwood Studios (Ent.) | $139,800 | **5** | 5 | 43 |

The five accounts paying the most generate **64 events** between them. The five paying nothing
generate **116**. Six Enterprise accounts holding **$841,131 — 56% of the entire book** — produce
fewer than 15 events each in a quarter.

This is the argument for separating health from priority. If ARR went into the score, an Enterprise
account would look healthier for paying more, and the dashboard would be unable to state the one
thing leadership most needs to hear. Keeping them on two axes is what produces the headline
**$391,024 of ARR at risk**.

---

## 4. Signals evaluated

Everything the events could plausibly support, and whether it earned a place.

| Signal | What it measures | Why it might indicate health | Limitations | Used? |
|---|---|---|---|---|
| **Days since last event** | Recency | The clearest churn signal available, with real spread (0–43 days) | Cannot distinguish a holiday from abandonment inside a 90-day window | **Yes — 30 pts** |
| **Distinct active users (30d)** | Breadth | Detects single-user dependency, the risk that kills renewals when one person leaves | A 5-person company with 1 user may be fully adopted | **Yes — 25 pts** |
| **Guides created + shared (30d)** | Depth / core value | The product is bought to capture and distribute knowledge; this is the act that delivers it | Assumes creation is the value. An account consuming a library built earlier looks worse than it is | **Yes — 25 pts** |
| **Active weeks of the last 8** | Consistency | Distinguishes a habit from a one-off burst, and stays stable at low event volumes | A weekly reporting ritual scores the same as daily use | **Yes — 20 pts** |
| Total event count | Volume | More usage is usually better | Rewards noise and account size; here it correlates *negatively* with ARR | No |
| Events per active user | Intensity | Normalises for account size | 186 users with 1–8 events each — the denominator is too small to mean anything | No |
| Active users ÷ known users | Penetration | Detects a team drifting away | "Known users" is only who appeared in 90 days, not the licensed seat count. The ratio's denominator is itself a usage metric | Shown as context, not scored |
| Guide views | Consumption | An audience exists | 34% of all events. Cannot distinguish one person scrolling from a team learning | Charted and used in the *no-audience* risk, not scored |
| Logins | Presence | Someone is showing up | Presence without production is the pattern that precedes churn — see Cedarline. Counting it as health would actively mislead | Used as a negative signal only |
| Users invited | Expansion intent | Someone is growing the account | 47 events total, and the invitee never appears as a distinct new user, so activation cannot be measured | No |
| 30d vs prior 60d volume | Trend | Decline precedes silence | On a median of 19 events, this is noise | **Computed, gated, never scored — §5** |
| Active-user change | Adoption trend | Losing people is sharper than losing events | Same volume problem, plus unequal windows if done carelessly | Gated risk only |
| Top user's share of events | Key-person risk | Concentration is fragility | Mechanically high on small accounts | Displayed as evidence, not scored |
| Tenure / contract age | Lifecycle | Onboarding accounts behave differently | Every contract predates the window, so no account's first 90 days are visible | No |
| Hour of day, day of week | Workflow fit | Embedded in the working day | The distribution is a generator artifact (§2) | **Refused** |

The goal was a small number of strong signals, not a large number of available ones. Four pillars,
each mapping to one sentence a CSM reads.

---

## 5. Trend: computed, shown, deliberately not scored

This is the decision worth defending most.

The temptation is obvious — the brief asks about trend, the data has timestamps, a 30-vs-30
comparison is four lines of code. But the median account produces 19 events in 90 days. That
comparison runs on roughly six events per side. A 50% "decline" is one or two events.

Scoring that manufactures false alarms, and a churn alert that fires on noise destroys a CSM's trust
in the tool faster than having no alert at all.

So trend is gated twice: the account needs **≥12 events** in the window for the comparison to mean
anything, and the change must be **≥50%** to survive the remaining noise. The result on this data:

| Account | Change | Evidence |
|---|---|---|
| Cedarline Insurance | **−85%** | 1 event in the last 30 days vs a run rate of 6.5 |
| Gladwell Education | −56% | 4 vs 9.0 |
| Quarrystone Consulting | +56% | 14 vs 9.0 |
| Brightside Logistics | +60% | 16 vs 10.0 |

**Four accounts out of 25**, not 25 flapping arrows. And even for those four, trend appears as
evidence and as a risk — it is never worth points, because a score that moves on noise is a score
nobody can defend.

---

## 6. Risks

A metric moving is not automatically a business risk. Each rule below has a definition, a reason it
matters commercially, and a stated false-positive mode.

| Risk | Rule | Why it is a business risk | False positives | Fires on |
|---|---|---|---|---|
| **Dormant / Going quiet** | no events ≥21d (Medium), ≥30d (High), ≥60d (Critical) | The product has left the workflow; a renewal conversation with no recent usage to point at is a conversation about price | Seasonal lull — a 90-day window cannot tell | 4 accounts |
| **No guides created or shared** | 0 created and 0 shared in 90d | Paying for a guide platform and producing no guides. The state that precedes non-renewal while the usage chart still looks alive | An account in pure-consumption mode on a library built before the window | 2 |
| **Single-user dependency** | exactly 1 active user in 30d | The account survives on one person; if they leave, usage goes to zero with no warning and no internal advocate | A genuinely one-person team | 4 |
| **Usage declining sharply** | ≥12 events and ≥50% drop | Decline shows up before silence; catching it early leaves time to intervene | Small-number volatility — hence the gate | 2 |
| **Team walking away** | ≥12 events, ≥3 prior users, active users down ≥50% (30d vs the *previous* 30d) | Losing people is sharper than losing events: one enthusiast can hold the event count up while the team has already stopped | Vacation season | 1 |
| **Logging in without creating** | ≥12 events, logins ≥60%, nothing created or shared in 30d | Users show up and produce nothing. Usually the champion left or the use case ended | A very new account still exploring | 0 |
| **Guides created, nobody watching** | ≥5 created and views < created | A champion invests effort the organisation does not consume; the value never lands, so there is nothing to point at when the spend is questioned | Guides staged for a future rollout | 2 |
| **Plan downgraded** | latest event's plan < contracted plan | A commercial decision the customer already made, independent of usage | Export lag | 2 |
| **High-value, minimal adoption** | top-quartile ARR, not Healthy, <12 events | The gap between what the account pays and what it uses is the gap a procurement review will find | — | 2 |

Ten of 25 accounts carry at least one risk; 19 risks in total. The three marked *affects health* in
the UI are the same three that cap the health tier — they are not scored twice, they are one rule
surfaced in two places.

### A note on comparing user counts

The active-user trend compares the last 30 days against the **previous 30 days**, not against the
prior 60. Comparing a 30-day distinct-user count against a 60-day one is not a comparison: the
longer window accumulates more distinct people by construction, and every account would look like it
was shrinking. The pipeline keeps both figures separately for exactly this reason.

---

## 7. Severity

Severity should be explainable to a CSM in one breath, so it is derived rather than assigned:

```
severity = the signal's own strength          (e.g. dormant 21d → Medium, 30d → High, 60d → Critical)
           + 1 level if top-quartile ARR      (≥ $106,024 on this portfolio)
           + 1 level if ≥2 risks fire together
           held at High when every health pillar is strong
```

That is the CSM's own reasoning made explicit: **how bad is it, how much does it cost us if we are
right, and does anything else agree.** All three inputs are visible on the account page.

Two guards stop the escalations from manufacturing urgency:

- **A risk whose definition already contains ARR is not escalated for ARR.** "High-value account, minimal adoption" would otherwise count the same fact twice.
- **Convergence does not escalate on a low-confidence account.** When five rules fire on an account with four events, that is the same thin evidence read five ways, not five independent signals agreeing. The account page says so in as many words rather than silently not escalating.

The result is 6 Critical and 13 High across 19 risks — a severity spread that discriminates, rather
than everything reading red.

**Worked example 1 — ARR.** Redwood Studios and Tidewater Retail are both dormant, and dormancy at
that length starts both of them at **High**. Redwood ends at **Critical** because $139,800 puts it
in the top quartile; Tidewater stays at **High** on $0. Same illness, different urgency, and the
difference is the account's value rather than anything about its usage.

**Worked example 2 — convergence.** Cedarline Insurance reaches **Critical** by the other route.
At $65,656 it is *not* top-quartile, so ARR buys it nothing; what escalates it is that **five
independent rules fire on it at once** — no core value, single user, usage collapse, adoption
collapse and dormancy. Any one of them is arguable. Five together are not.

Together these answer "how should a CSM prioritise", and the answer falls out of the rules rather
than being asserted.

---

## 8. Edge cases

| Case | Present? | How the model handles it |
|---|---|---|
| **No events at all** | Not in this export | Tier `No Data`, never At Risk. Absence of evidence is as likely to be a broken pipeline as a lost customer, and the two need opposite responses. Scoring an empty set as zero is the classic health-score failure |
| **Very little activity** | Birchwood 3, Pinnacle 4, Redwood 5 | Scored normally but tagged **low confidence**, and convergence escalation is withheld. The verdict is shown — a silent account is exactly what a CSM needs to see — but it is labelled |
| **Many events, one user** | Pinnacle (1 of 2 active), Harborview (1 of 4) | Breadth scores near zero and the tier is capped below Healthy. The score alone would have called some of these Healthy |
| **High ARR, low usage** | Pinnacle $185K/4 events, Redwood $139K/5 | Health reflects the usage; ARR drives it to the top of the worklist through priority. Also raises its own named risk |
| **Declining usage** | Cedarline −85%, Gladwell −56% | Reported as evidence and risk, never as points. Cedarline is At Risk on its pillars regardless; Gladwell is Healthy and its decline is shown at High, not Critical |
| **Recovery after a gap** | Silvercreek and Thistle & Vine, 3 new users each in 30d | Recency and Breadth are measured on the recent window, so a recovering account reads as recovering rather than as its dead history |
| **Multiple workspaces** | 3 accounts | Rolled up to the account; users deduplicated (a no-op here, since the sets are disjoint). The drill-down shows the per-workspace split so a half-adopted second team is visible |
| **Inconsistent plan** | 2 accounts | Contract wins for display; drift becomes a commercial risk flag outside the score |
| **Healthy account with a risk** | Thistle & Vine, Gladwell, Fernhill | Severity held at High. Critical means act this week; on a thriving account a single flag is a conversation, not a fire |

---

## 9. The model

### Why a score *and* tiers

- **Tiers alone** give no ordering inside a tier, and five At Risk accounts need a first one.
- **A fitted model** has nothing to fit: 25 rows, no churn labels, and a score nobody could defend line by line.
- **A score built from four named pillars** gives both — an ordering, and an explanation that is the score rather than a story told about it.

### The model

```
Recency      30   ≤7d:30  ≤14d:22  ≤30d:12  ≤60d:4  else 0
Breadth      25   ≥7 users:25  4–6:19  2–3:12  1:5  0:0      (active, last 30d)
Depth        25   cv≥6:25  cv≥3:18  cv≥1:10  cv=0:0           cv = created×2 + shared, last 30d
                  cv=0 but activity earlier in the window → 4 ("stopped creating" ≠ "never created")
Consistency  20   ≥6 weeks:20  4–5:14  2–3:8  1:3  0:0        (of the last 8)

Healthy ≥75 · Watch 45–74 · At Risk <45 · No Data when no events exist

Caps applied after the arithmetic:
  silent ≥30d                     → At Risk
  never created or shared         → not Healthy
  ≤1 active user in 30d           → not Healthy
```

Thresholds are **calibrated, not fitted** — chosen so this portfolio splits into groups a CSM can
act on, then checked against the observed distribution. With real churn outcomes they would be
fitted, and that is the first item in the production roadmap.

### The result

| Tier | Accounts | ARR |
|---|---|---|
| Healthy | 15 | $991,198 |
| Watch | 5 | $112,247 |
| **At Risk** | **5** | **$391,024** (26% of the book) |
| No Data | 0 | — |

Scores spread across the full range — 11, 11, 29, 30, 31 / 59, 60, 65, 66, 73 / 79…100 — with clear
gaps at both tier boundaries rather than a cluster sitting on a threshold.

**On the caps, honestly:** they fire ten times on this snapshot (single-user 6, dormant 2, no core
value 2) and change the final tier **zero** times — the score had already reached the same verdict
in every case. That is worth saying out loud rather than leaving for a reader to discover. They are
not tuned to this data, and they are not ornamental either: the failure mode they close is
structural. Strip a thriving account's recency pillar and the other three still carry it past 75, so
it reads Healthy a month after it went silent. `tests/health.test.ts` builds exactly that account
and asserts it comes back At Risk. On a portfolio with a genuine lapsed-champion account, the caps
would be the only thing catching it.

### Priority

```
priority = tier weight (At Risk 3 · Watch 2 · Healthy 0) × (1 + log₁₀(1 + ARR))
```

ARR is log-scaled so a $218K account outranks a $66K one without one whale flattening the list, and
Healthy accounts score exactly 0 — there is nothing to prioritise. The list opens on **Pinnacle
Manufacturing: $185,568, one active user, 21 days silent, four events in a quarter.**

---

## 10. What the drill-down shows, and why

The requirement is that a CSM understands a classification without inspecting raw events. The page
is ordered so a reader can stop after any section and still be right:

1. **Verdict** — tier, score, plan, ARR, owner, and a low-confidence label where it applies
2. **Why** — the four pillar sentences with their points. The score is their sum and nothing else
3. **What overruled the arithmetic** — each cap with its own reason, and what the score alone would have said
4. **Risks** — evidence, the commercial reason it matters, and the severity derivation spelled out
5. **Activity over 13 weeks** — stacked by *what the activity was*, with the 30-day scored window marked
6. **Exact event counts** — so nothing on the page depends on reading a colour
7. **People, workspaces, and anything qualifying the verdict**

The chart splits activity into created-and-shared, viewed, and logins-and-invites rather than the
five raw event types. That is the whole point: Cedarline Insurance's chart is a solid wall of
presence with no value in it, and no amount of total-event counting would have shown that.

---

## 11. Limits of this analysis

- **25 accounts and 480 events.** Every threshold is a judgement calibrated on one small snapshot.
- **One snapshot, no history.** The most useful thing a CSM could be told — "three accounts dropped out of Healthy this week" — is exactly what a single export cannot support.
- **No outcomes.** Nothing here has been validated against an account that actually churned. The model is defensible, not proven.
- **Seats are unknown.** "Active users out of known users" uses observed users as the denominator, not licensed seats, so true penetration cannot be measured.
- **Silence is ambiguous.** A dead pipeline and a dead customer look identical in this data. That is why no-data is its own tier and why ingestion-freshness monitoring is second on the production list.

---

## 12. Assumptions

1. **`company_name` joins the two files.** Verified exactly 1:1 on this snapshot. The join still runs through a canonicalization step (case, whitespace, punctuation, legal suffixes) so the assumption is explicit and a fuzzy matcher can replace it in one place.
2. **`accounts.json` is the commercial source of truth** for plan and ARR. `plan_tier` on an event is historical state; disagreement is surfaced, never silently resolved.
3. **The account is the unit of health.** Workspaces roll up; users are deduplicated across them (unnecessary on this data, where the sets are disjoint, but the code does it anyway).
4. **"Today" is the latest event timestamp (2026-09-13), not wall-clock time.** Otherwise every account would drift into dormancy and the demo would rot.
5. **The 90-day window is all the history there is.** Trend is strictly within-window; there is no pre-window baseline to compare against.
6. **`guide_created` and `guide_shared` are the product's core value.** This is the most product-opinionated assumption in the model and the one most worth challenging — it is what makes Cedarline Insurance At Risk despite a healthy-looking event count.
7. **Absence of events means absence of usage, not a broken pipeline.** Untestable from a single snapshot, which is why a zero-event account is `No Data` rather than `At Risk`.

## 13. Open questions (product decisions, not data ones)

1. Should a **Free** account be scored on the same axis as an Enterprise one, or is "health" for a free account really conversion likelihood? The four highest-usage accounts here are free and worth $0.
2. Is `guide_viewed` value delivered (an audience exists) or noise (one person scrolling)? It is 34% of all events and the Depth pillar currently ignores it.
3. What is the real churn window? These thresholds are **calibrated** to split this portfolio usefully. With historical churn outcomes they would be **fitted** instead.
4. Should CSM ownership feed priority? The data supports it — four CSMs hold 5–7 accounts each, very unevenly distributed by ARR.

## 14. What I'd build next for production

1. **Fit the thresholds instead of calibrating them.** Everything here is a defensible guess. With 12 months of renewal outcomes, the bands become a logistic fit and the pillars get weights that mean something — while keeping the "score = sum of stated reasons" contract, which is the part worth protecting.
2. **Ingestion-freshness monitoring per workspace.** Assumption 7 is the dangerous one: today a broken pipeline and a churning customer look identical. A per-workspace last-seen heartbeat separates them before a CSM makes a call based on silence that was ours, not theirs.
3. **Track verdict changes over time.** The UI's "score 30 days ago" comparison (`src/lib/history.ts`) gets there today by re-running the pipeline on an earlier snapshot on every request — a fine trick for one comparison point on 480 events, and not how this should work at real volume or for more than two points in time. The single most useful thing a CSM wants and a re-run can't give: *"three accounts dropped out of Healthy this week."* That needs the pipeline to run on a schedule and persist each verdict, not recompute history live.
4. **Close the loop.** Let CSMs mark a risk as acknowledged or wrong, and store it. Those annotations are both the UX fix for false positives and the labelled training data that step 1 needs.
5. **Scale the data layer.** SQLite and a full rebuild are right for 480 events and honest about it. At real volume this becomes an incremental warehouse job with the same stage boundaries — the pure functions move; nothing else about the model has to.
6. **A memory-backed chat, not just a stateless one.** "Ask the data" (see the README) resends plain text history and re-derives everything fresh each turn — correct at 25 accounts, but a longer investigation ("compare this to what we discussed about Redwood last week") would want the tool results themselves persisted, not just the prose summary of them.
