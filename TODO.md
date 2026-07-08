# kitbash — candidate apps & package roadmap

Output of a multi-round research pipeline (6 parallel research agents → 35 raw
app ideas → 10 shortlisted → all 10 adversarially validated against live
competitors → 3 re-opened under a corrected validation lens). Written for a
downstream planning pass — everything a next reader needs is inline, nothing
assumes prior conversation context.

## Hard requirements every candidate was screened against

1. Design is explicitly not the differentiator (operator is not design-focused,
   and considers agents not yet fully competent at it either) — win on
   simplicity/flow/pricing, not visual polish.
2. Audience priority: individuals >> learning institutions > businesses.
   Individual usefulness is required; institution/business usefulness is a
   bonus only, never load-bearing.
3. Revenue mechanism must be concrete and is a go/no-go gate, not "figure out
   later" — acceptable forms: consumable tokens, subscription, or a cut of a
   user-to-user transaction/interaction.
4. Must be novel, or — if similar products exist — must have a differentiating
   twist. **Validation criterion, corrected mid-project:** a competitor
   existing is NOT disqualifying by itself; it's evidence of demand. The twist
   can be pure execution quality — a radically simpler onboarding/flow, or a
   more generous free tier before paywall — not just an uncontested niche.
   Reference case: cvmake won in an already-crowded resume-builder market via
   a ~2-step onboarding flow and a free tier competitors didn't offer.

All 10 shortlisted ideas went through adversarial validation against live
competitors. The 3 apps below are the ones judged to have a real
execution-superiority angle against their named competitors once re-examined
under the corrected criterion 4. Of the other 7: 2 were never hard-killed
(they were "moderate, leaning weak" and just didn't have as clear a
superior-execution story as the 3 below), and 5 were genuinely killed by
live, hard-to-beat competitors. All 7 are summarized in the appendix for the
record, in case a fresh angle on one of them surfaces later.

---

## App 1: Reseller Profit & Tax Copilot

**Pitch:** Online resellers (eBay/Poshmark/Mercari/Whatnot/Depop) upload their
marketplace CSV exports; the app normalizes fees/COGS/shipping across
platforms and outputs a live profit view plus a Schedule‑C‑ready tax summary.

**Audience:** Individual resellers, side-hustle to serious — no institution/
business angle needed.

**Monetization:** Validated MVP is a one-time $15-30 tax-season purchase
(consumable). The execution-superiority reframe makes a recurring
subscription plausible too (comparable competitors already charge $10-50/mo),
*if* onboarding is genuinely simpler than theirs — otherwise stay one-time to
de-risk.

**Why competitors don't close this out:**
- **Seller Ledger** ($10+/mo, scales with volume) — closest live clone:
  connects to eBay/Poshmark/Mercari/Whatnot, imports fees/COGS, generates
  Schedule C reports. Real, priced similarly, already doing this.
- **My Reseller Genie**, **Flipwise** ($9.99-$69.99), **Nifty** ($69.99/mo,
  bundled with crosslisting) — all also do fee-aware profit tracking + tax
  export.
- **Vendoo** — fee-calculator only, no bookkeeping (confirmed gap holds).
- **QuickBooks Self-Employed** stopped new signups (~2024), replaced by
  Solopreneur, which explicitly dropped inventory/COGS tracking — signal of
  an unmet need, not a competitor.
- **The twist:** every incumbent above requires real setup — connecting
  accounts, manual entry, multi-step configuration — and reviews show users
  keep side-spreadsheets anyway. None advertise a real free tier past a
  trial. A genuine 2-step "upload → see your profit" flow, plus a usable-not-
  a-teaser free tier, is the cvmake-style wedge here.

**Real build risk (not solved by kitbash):** Poshmark, Mercari, Depop, and
Whatnot have **no public API** — ingestion is CSV export or fragile scraping
only. eBay's API exists but is approval-gated. This ingestion/normalization
work is the hard, valuable 80% of the build and kitbash's OAuth/billing
scaffolding does nothing for it.

**Regulatory:** standard "not tax advice, consult a professional" disclaimer —
same pattern every competitor already uses. Not a blocker.

**Open questions to resolve before/during build:**
- [ ] Is a real (non-teaser) free tier financially sustainable given per-user
      CSV-parsing/compute cost?
- [ ] Can "2 steps" survive contact with genuinely inconsistent per-marketplace
      CSV formats, or does it become 2 steps *most* of the time with a manual
      fallback?
- [ ] One-time purchase vs. subscription — decide based on how much the
      onboarding-simplicity wedge actually holds once built (measure, don't
      assume — see `pulse` funnel note below).

---

## App 2: RSU Vesting & Withholding-Gap Tracker

**Pitch:** Tracks RSU/equity-comp vesting schedules across multiple
employers/grants, flags the gap between actual withholding and true marginal
tax owed, and nudges the user at vest events and quarterly tax deadlines.

**Audience:** Individual equity-comp holders (mostly tech workers). ~14-25M US
workers hold some equity comp, but the specific "multi-employer,
high-bracket, needs-withholding-gap-math" niche is much thinner — plausibly
low hundreds of thousands to low millions.

**Monetization:** Validated recommendation is a one-off paid "tax season
report" (vesting calendar + gap flags + suggested quarterly payments) rather
than a subscription by default — add recurring billing only if the report
sells organically. This is the least monetization-proven of the 3.

**Why competitors don't close this out:**
- **Monarch Money** already ships "Equity Tracking" (RSU/ISO/NSO/RSA) on its
  $199/yr Plus tier — the single biggest threat — but it's one feature bolted
  onto a full net-worth app that requires linking your *entire* financial
  life (every bank/brokerage account) just to use it.
- **myStockOptions.com** — dated, education-heavy, a basic grant record-keeper,
  not a tax-gap engine.
- **Kubera** / **Compound Planning** — net-worth/advisory tools touching RSUs
  peripherally, not focused trackers. **Secfi** is option-financing/advisory,
  not a tracker.
- Note for whoever picks this up: round-1 research also cited "Cartwheel" and
  "Ambrook" as comparable products — **both were confirmed false/hallucinated**
  during validation (unrelated companies: delivery, farm bookkeeping). Do not
  cite them as competitors going forward.
- **The twist:** a single-purpose tool needing only grant terms — no bank-
  linking, no net-worth dashboard — is a materially simpler alternative to a
  feature buried inside Monarch's everything-app.

**Real pain point, sized honestly:** IRS Form 2210 underpayment penalty
(~7-8% annualized) is real but mild/avoidable — triggers only above a $1,000
shortfall, and only if safe harbor (90% current-year or 100/110% prior-year
withholding) isn't met. Many RSU holders already clear safe harbor via base
salary withholding alone.

**Biggest unresolved doubt:** the market's proven pattern here is free
calculator *or* paid human advisor, not micro-SaaS subscription — no evidence
was found of an existing $7-10/mo product succeeding in this exact niche.
This is the shakiest revenue case of the 3 apps in this document.

**Build complexity:** Manual entry is viable for an MVP — grant data changes
rarely, unlike transaction feeds that would need Plaid-style bank sync. Core
value needs only grant terms + a short tax-profile questionnaire + a public
stock-price API.

**Open questions to resolve before/during build:**
- [ ] Validate willingness-to-pay directly (e.g., sell the one-off report
      before building the full tracker) before investing in subscription
      infrastructure — this idea's revenue case is unproven relative to the
      other two.
- [ ] Decide the minimum viable "gap math" — full marginal-rate modeling vs. a
      simpler safe-harbor-only check.

---

## App 3: Collector's Ledger

**Pitch:** Catalog collectibles across 2-3 adjacent niches (e.g., coins +
stamps + banknotes — not "any category") with resale-value tracking and
one-tap appraisal/insurance PDF export.

**Audience:** Individual collectors/hobbyists. Minor upside for small resale/
consignment shops (not required).

**Monetization:** ~$5-6/mo subscription (matches established competitor price
points) **plus** consumable tokens for on-demand "refresh market comps" per
item/lot — a dual subscription + consumable model.

**Why competitors don't close this out:**
- **CLZ/Collectorz** — five separate apps (Books/Movies/Music/Games/Comics),
  ~$39.95/yr each, no unified any-category tier, no non-media categories.
- **Coleka** — free w/ ads; premium unlocks real-time value estimates tied to
  eBay data, across arbitrary categories.
- **Collectibles.com: Scan+Value** — AI photo-scan ID + valuation from
  "150M+ sold items"; cards, coins, stamps, figures, memorabilia.
- **Kolekto** — unlimited categories, ~$5.99/mo — **already at the proposed
  price point.**
- **iCollect Everything** (25+ types, ~$70-80/yr), **Classifier** (any
  collectible, general-purpose) — also live.
- **The twist, corrected from round 1:** the original "any category" framing
  is the wrong shape — round-1's own research found the real money in this
  space goes to *deep single-niche* tools: **Collectr** (TCG-only) reached
  8-figure ARR and 4M+ users; **Vivino** (wine-only) hit 60-70M downloads. The
  actual wedge is narrow-niche depth + a better onboarding/free tier than the
  broad generalists above, not breadth.

**Real cost/data risk:** eBay's Marketplace Insights API — the only official
sold-price data source — is "Limited Release," gated behind business-level
approval, not available to an indie app. WorthPoint's own price-guide
business charges **$29.99-59.99/mo just for data access** — real evidence
that quality pricing data is an expensive moat, not a cheap add-on at $5/mo.

**Open questions to resolve before/during build:**
- [ ] Pick the 2-3 launch niches (recommend starting from adjacent,
      underserved categories, not head-on against Collectr/Vivino-style
      category leaders).
- [ ] Solve comps sourcing cheaply for MVP — manual/weekly-batch refresh or
      community-sourced pricing before paying for a real data feed.

---

## Kitbash package plan

### Existing packages — already cover all 3 apps

| Package | Role across the 3 apps |
| --- | --- |
| `oauth` | Sign-in for all three. No changes needed. |
| `shop` | Covers every monetization shape needed: one-time consumables (Reseller Copilot's tax report, RSU's tax-season report) and subscription + consumable **mixed in one config** (Collector's Ledger's $5-6/mo + comps-refresh tokens) — Paddle/RevenueCat already support this combination natively. |
| `pulse` | Matters most for Reseller Copilot specifically — the whole pitch is "2-step onboarding," and Pulse's funnel query (`/query/funnel?steps=...`) is the actual instrument to prove that claim true and catch drop-off. Use it on all 3 to measure activation, not just revenue. |
| `ship` | All three ship to web/iOS/Android/Windows. Matters most for Collector's Ledger (cataloging by photo wants a real camera → native build); the other two are fine PWA-first. |
| `onboarding` (spotlight tours) | Useful for Collector's Ledger's first-item flow and RSU Tracker's first-grant-entry flow. Deliberately skip or use minimally on Reseller Copilot — *not* needing a tour is the actual differentiator there. |

### New packages to build — ranked by cross-app reuse

1. **`reports`** — renders a structured data record as a shareable PDF/export.
   Needed by **all 3 apps**: Reseller Copilot's Schedule C summary, RSU
   Tracker's tax-season report, Collector's Ledger's appraisal/insurance
   export are the same underlying problem. **Build this first, regardless of
   which app ships first** — it pays off on all three.
2. **`notify`** — cross-platform push notifications + scheduled local
   reminders. Needed by RSU Tracker (vest-date and quarterly-tax-deadline
   nudges) and Reseller Copilot (quarterly upload reminders). This is a
   **total gap in kitbash today** — none of the 5 existing packages touch
   notifications at all — and it's foundational for any future date-driven
   app beyond these 3.
3. **`catalog`** — generic structured-record CRUD + list/grid/detail UI with
   flexible per-category fields. Needed directly only by Collector's Ledger
   today, but it's the connective tissue behind most "personal database of
   things" ideas that came out of round-1 research (home inventory, expiry/
   document trackers, gift-tracking, etc.) — high future leverage even at
   1-of-3 today.
4. **`capture`** — photo/media capture UI (cross-platform via Capacitor) +
   pluggable storage abstraction (mirrors Pulse's pluggable-store pattern:
   local/S3/R2). Needed directly only by Collector's Ledger; validation
   research explicitly flagged photo storage/hosting at scale as a real,
   currently-unsolved kitbash gap, and it recurs across inventory-style app
   ideas.
5. **`ingest`** — CSV/file import + column normalization + pluggable
   per-marketplace fee-formula adapters (eBay/Poshmark/Mercari/Whatnot to
   start). Needed only by Reseller Copilot right now — narrowest reuse of
   the five, but it *is* the hardest/most valuable part of that app's build.

### Flagged, not yet a package decision

- **US quarterly-estimated-tax / safe-harbor logic** (Form 2210 math) is
  shared real code between Reseller Copilot and RSU Tracker — but it's
  domain/business logic, not generic infrastructure like the five packages
  above and the five existing kitbash modules. Recommend sharing it directly
  between those two app codebases regardless of build order; only promote it
  to a proper `kitbash` package if more tax-adjacent apps get added to the
  roadmap later.

---

## Suggested next steps

- [ ] Decide build/launch order across the 3 apps (none has a dependency on
      another; `reports` is the one piece worth building before committing to
      an order, since it serves whichever ships first).
- [ ] For whichever app ships first, resolve its "Open questions" above before
      writing product code, not after.
- [ ] RSU Tracker specifically should validate willingness-to-pay (sell the
      report) before the other two, since its revenue case is the least
      proven of the three.

---

## Appendix: ideas researched and rejected

All 7 below were adversarially validated but not chosen for the 3 slots
above. They split into two groups — don't conflate them:

### Not hard-killed — just didn't have as clear a twist as the 3 above

Both scored "moderate, leaning weak" in validation, same tier as the 3 apps
above started at before the execution-superiority reframe. They're here
because that reframe wasn't applied to them as convincingly, not because a
competitor makes them impossible. Worth revisiting if a sharper twist surfaces.

| Idea | Why it wasn't picked this round |
| --- | --- |
| Blueprint-weighted certification prep engine | Real gap, but collides with free NotebookLM DIY workaround, CompTIA's ToS ban on AI-generated study content, and a documented AI-question-quality problem. |
| Whatnot break profitability / show-recap tool | Real proven demand (an Etsy spreadsheet template already sells), but Whatnot's Seller API is closed-beta and the platform is building similar analytics in-house. |

### Genuinely killed — competitor moat looked too strong to out-execute

| Idea | Killed by |
| --- | --- |
| Verified-practitioner critique marketplace | Funded incumbents (FAANGPath, Exponent, IGotAnOffer) already sell this at $119-300+; the cheaper band fails reviewer unit economics; only idea needing bespoke Stripe-Connect-style payment-splitting infra kitbash doesn't have. |
| Financial-aid award-letter decoder | Niche shipped a near-identically-named free tool in Mar 2026; 3 more free/funded competitors; ~10-week once-ever buying season with no repeat purchase. |
| Household inventory / "black box" tracker | RecallSentry (launched Mar 2026) already gives away the exact pitch free; several insurers do too. |
| RV + tow-vehicle maintenance log | The "incumbent is hated" premise was a sampling artifact (real rating 4.6-4.7★ over 60k+ reviews); free dedicated competitors already fill the actual gap. |
| Parent-side IEP/504 tracker | 7 live parent-facing competitors, including one near-identical and cheaper, and one backed by a $1M prize. |

25 additional raw ideas from the first research round were never put through
adversarial validation at all (available on request — not included here to
keep this document focused on actionable candidates).

---

# Praxis review — 2026-07-08

Read against the live kitbash tree (5 shipped packages) and the products
already in production (QUYSS, cvmake). The research quality above is high —
the corrected validation lens (competitor = demand evidence, twist can be
execution) is the same logic that made cvmake work, and the appendix honesty
(hallucinated competitors called out, kills documented) makes the surviving 3
trustworthy. My disagreements are almost all about *sequencing and extraction
discipline*, not about the research.

One meta-observation up front: the doc proposes **5 new packages against 3
apps, none of which is started**. That ratio is inverted. Packages earn their
API by being extracted from working products — pulse's shape came from real
QUYSS traffic, shop's from a real cvmake checkout. Of the five proposals I
would build exactly one now, one alongside its first consumer, and let the
other three be extracted later if their consumer ever exists.

## Apps

### App 1: Reseller Profit & Tax Copilot — BUILD (first pick), gated on one spike

The demand evidence is the strongest of the three and the wedge is the proven
cvmake shape. Two things the pitch under-weighs:

1. **The CSV treadmill is permanent, not one-time.** No-API marketplaces mean
   every export-format drift breaks every user at once. This is actually a
   decent fit for an agent fleet — "format changed, here are 3 sample rows,
   regenerate the adapter + fixture" is exactly the kind of maintenance we
   automate well — but it must be priced in as a forever cost, not a build
   cost.
2. **Seasonality.** Revenue concentrates Jan–Apr. The year-round hook has to
   be the live profit view; the tax report is the seasonal consumable on top.
   Launching off-season with only the tax artifact means months of silence
   before any validation signal.

**Gate before committing:** a 1–2 week ingestion spike — real CSV exports
from eBay/Poshmark/Mercari (seller forums have samples), prove the
normalizer on genuinely messy files, and answer the doc's own "does 2 steps
survive contact" question. If the spike says "2 steps most of the time with a
manual mapper fallback", that is still shippable; if every file needs the
mapper, the wedge is gone and this drops to DON'T BUILD.

### App 2: RSU Tracker — VALIDATE ONLY, do not build the product

The doc already says the revenue case is the shakiest and the pain is
mild/avoidable; I'll go one step further: the validated recommendation
("sell the report first") means the correct build right now is **a landing
page + pre-order for the one-off report, with the first N reports produced
semi-manually**. Zero product infrastructure until money clears. The
free-calculator-or-human-advisor market pattern is a strong prior against a
micro-SaaS here, and safe-harbor-via-salary-withholding removes the pain for
a big slice of the niche.

Why it stays on the list at all: the audience overlaps the operator's own
network (tech workers), so the willingness-to-pay test is nearly free. That
is the only investment it has earned.

### App 3: Collector's Ledger — DON'T BUILD NOW, and here is the reflection

The doc's own corrected twist kills the doc's own pitch. Round-1 research
found the money is in *deep single-niche* tools (Collectr, Vivino); the pitch
is still "2–3 adjacent niches", which is breadth-lite, not depth. And the
data moat is the real product: sold-comps pricing costs $30–60/mo/user at
retail (WorthPoint) while the plan charges $5–6/mo. Without an affordable
comps source, what remains is CRUD + PDF export — which Kolekto already
sells at exactly the proposed price.

Not a permanent kill: the actionable version is "ONE named niche with a
legally accessible, cheap comps source" (e.g., a community that publishes
open price guides). Until someone names that niche and that source, there is
nothing to build. Parked, with a concrete reopen condition — that is the
difference between this and the appendix kills.

## Packages

### 1. `reports` — AGREE, build now, and extend from cvmake rather than invent

Right call and correctly ranked #1: all three apps need it, and so do the
products we already run — cvmake *is* a structured-record→PDF product today,
and QUYSS wants exportable agent/billing reports eventually. Two scope
guards: (a) extract the rendering approach from cvmake's working exporter
instead of designing fresh — extend, don't invent; (b) keep v1 to
"JSON + template → PDF/share-link" with 2–3 templates and a pluggable store
(pulse's pattern). No WYSIWYG editor, no chart library abstraction.

### 2. `notify` — AGREE it's the real gap, but build it WITH its first consumer

The gap analysis is correct — nothing in kitbash touches notifications, and
date-driven apps keep recurring. But a scheduler+push package built with no
consuming app will get its API wrong (delivery windows, quiet hours,
timezone handling, dedupe — all of these only surface against a real
product). QUYSS already runs web-push + SSE in production; that code is the
seed. Build `notify` in the same PR series as whichever date-driven app
ships first (RSU report reminders or Reseller quarterly nudges), not before.
Scope: web-push + APNs/FCM via Capacitor + email fallback, server-side
scheduler, per-user channel prefs.

### 3. `catalog` — DISAGREE, do not build. Extraction, not anticipation

Generic flexible-field CRUD with one consumer (an app we are not building)
is the textbook premature abstraction. The doc itself applies the correct
rule to the tax logic — "shared real code, but domain logic; share directly,
promote later" — and `catalog` fails that same test today: zero live
consumers. The future leverage claim is real but leverage is *realized by
extracting from the second consumer*, not by guessing the field model in
advance. Reopen automatically the day two "personal database of things"
apps are actually scheduled.

### 4. `capture` — SPLIT IT: storage half yes, camera half no

Two unrelated concerns are bundled here. The **pluggable blob store**
(local/S3/R2, one `put/get/sign` API) is reusable *today* — cvmake avatars
and exports, QUYSS uploads, pulse already proved the pluggable-store shape —
and it is small. Build that now as its own package (`store`), because it
also unblocks `reports` share-links. The **camera/photo-capture UI** serves
only Collector's Ledger, which is parked — and bundling a Capacitor-native
UI widget with server-side storage would force native deps onto server-only
consumers. Skip the camera half until a consumer exists.

### 5. `ingest` — AGREE with the doc's own caveat, sharpened: not a package

The doc ranks it last and admits the narrowest reuse; apply its own tax-logic
rule consistently and the conclusion is "this is Reseller Copilot product
code", full stop. Marketplace fee formulas and per-site CSV quirks are
domain logic that will churn weekly with the marketplaces — exactly what you
do NOT want versioned as shared infrastructure while it has one consumer.
If a second import-heavy app ever appears, extract the generic core (format
sniffing + column-mapping UI) then. Building it as an app module first also
makes the ingestion spike (App 1's gate) cheaper to start.

### Flagged tax logic — AGREE as written

Share the Form 2210 / safe-harbor math directly between the two app
codebases; promote only if a third tax-adjacent app appears. Same rule I
applied to `catalog` and `ingest` — the doc was right here and slightly
inconsistent with itself on those two.

## Corrections to the package table

- `shop` also speaks **Freemius** as of 0.3.0 (webhook + checkout adapter +
  RevenueCat bridge; cvmake is the live reference integration) — the doc and
  INDEX.md still say Paddle/RevenueCat only. Any of the 3 apps can therefore
  choose per-product between Paddle and Freemius without new work.

## Recommended sequence

1. **`reports`** (extract from cvmake) + **`store`** (blob half of
   `capture`) — small, both pay off regardless of app order.
2. **Reseller Copilot ingestion spike** — the go/no-go gate. Product code,
   not a package.
3. On a green spike: **Reseller Copilot MVP** with pulse funnels
   instrumenting the 2-step claim from day one. In parallel (cheap):
   **RSU landing-page pre-order test**.
4. `notify` ships with whichever date-driven feature arrives first.
5. `catalog`, camera-`capture`, `ingest`-as-package: closed until their
   reopen conditions above are met.

Net: of the 5 proposed packages — 1 build-now (`reports`), 1 build-now but
reshaped (`store`, half of `capture`), 1 build-with-consumer (`notify`),
2 declined for now (`catalog`, `ingest`) with explicit reopen conditions.
Of the 3 apps — 1 gated build, 1 validation-only, 1 parked.
