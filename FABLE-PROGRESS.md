# FABLE-PROGRESS.md — Strategic Opportunity Analysis run

Run started: 2026-07-06. This run executes the "MenuVoice Strategic Opportunity Analysis" trigger that was scheduled for the night of 2026-07-05 but never fired — it was auto-disabled with reason `auto_disabled_repo_access`. The previous contents of this file (the 2026-07-03 one-window audit log) are preserved in git history at commit e029b41.

Mission for this run, per the trigger prompt: act as a founder-level product strategist / CTO / accessibility expert and determine the single highest-leverage way MenuVoice could become dramatically more valuable as a business. Explicitly NOT an implementation run — no feature code changes. The final decision document goes to FABLE-ONE-WINDOW-RUNBOOK.md at the repo root.

---

## Log

**Step 1 — setup (done).** On branch `claude/code-analysis-automation-5lsj10`, based at main tip (e029b41). Repo survey: React+Vite SPA in `src/`, ~17 Vercel serverless functions in `api/` (chat, tts, transcribe, find-menu, menu-from-url, scrape, sync, events, dashboard, report, morning digest, cron), a11y tooling in `scripts/`, and a set of strategy/status docs (PRODUCT.md, IDEAS.md, ANALYTICS.md, REVIEW.md, VOICEOVER-AUDIT.md, FIXES-NEEDED.md, PROGRESS.md) that record what has already been believed and tried.

**Step 2 — internal audit (done).** Read PRODUCT.md, IDEAS.md, REVIEW.md, ANALYTICS.md, PROGRESS.md, FIXES-NEEDED.md, README.md, and surveyed the code (~9,300 lines TS across `src/` + `api/`). What I learned:

- *What exists is genuinely deep for a one-month-old project*: guided camera scanner with audio coaching, find-menu-by-name via web search, URL/PDF parsing, a provenance layer (official vs third-party source, location scope, freshness, completeness), explicit-vs-inferred allergen confidence with honest wording, voice conversation with strict turn-taking, VoiceOver-audited screens, full telemetry pipeline into Postgres with a live dashboard and a morning email digest.
- *The single most telling data point*: the analytics infrastructure is elaborate, but PROGRESS.md notes the events table was "almost empty," and the morning report's core question is "did anyone use MenuVoice." The excluded-internal-emails list is the founder. **There are effectively zero real users.** Every open workstream doc ends with "needs a real device / real user test" that never happens.
- *Recurring unresolved theme across all docs*: menu-data reliability and trust (Browserless token dead, JS-heavy chain sites fail, scanner thresholds "tuned on theory", incomplete-menu detection heuristic). The product's hardest problem is not UX — it's dependable menu data.
- *No revenue surface exists at all*: no pricing, no restaurant-facing anything, no partner story. Costs (OpenAI vision/chat/TTS/Whisper per session, Vercel) scale linearly with usage.

**Step 3 — market research (done).** Findings that changed my thinking:

- *Who pays in blindness tech: businesses, not users.* Menus4All charges diners $2.99/mo but converted to a nonprofit (Oct 2025) and now commits to being free for diners — the consumer-pay model failed even for the category leader with 750k menus. Be My Eyes is free for users and monetizes corporations. Good Food Talks (UK) charges *restaurants* a monthly fee and is live in 2,150+ venues including Nando's, PizzaExpress, and JD Wetherspoon — and was acquired by Nutritics, a food-data company. The proven business model in this exact category is: diners free, restaurants pay.
- *Restaurants have an urgent, documented reason to pay.* 3,948 ADA website-accessibility lawsuits were filed in 2025 (+24% YoY); Restaurants/Food/Beverage was the single most-targeted industry with 1,368 suits (34.7%). Inaccessible menu PDFs are specifically cited as the easiest target, and the standard recommended fix is "replace the scanned menu PDF with accessible HTML." Accessibility overlays are failing (22.6% of suits hit sites that had widgets installed; FTC fined a major overlay vendor $1M).
- *The free-AI substitute threat is real and growing.* Be My AI / ChatGPT voice can already photograph a menu and talk about it for free. A nicer wrapper around GPT vision is not a durable consumer moat. What free AI structurally cannot offer: menu and allergen data *confirmed by the restaurant*. That is also precisely MenuVoice's own hardest internal problem per its docs (everything is "may contain," "inferred," "tuned on theory").
- *Nobody owns the US version of this.* Good Food Talks is UK-only. Menus4All is a nonprofit aggregator without a voice conversation or verified-allergen layer. BentoBox/Popmenu sell whole-website WCAG compliance, not the at-table experience or a blind-diner destination. ~675K US restaurant locations; independents already pay $50–350/mo for digital tools.

**Step 4 — synthesis (done).** The three problems — zero users, zero revenue, unreliable menu data — have a single common solution: get restaurants to supply and confirm their menus, and charge them for it. Writing the decision document to FABLE-ONE-WINDOW-RUNBOOK.md now.

**Step 5 — decision document written (done).** FABLE-ONE-WINDOW-RUNBOOK.md created at the repo root with all ten required sections. The recommendation: **MenuVoice Verified** — a hosted, restaurant-confirmed accessible menu page (`/m/{slug}`) that restaurants pay for, integrated into the consumer app as instant trusted data with upgraded allergen wording. Five opportunities were weighed (restaurant-facing verified menus, consumer verified-menu network, enterprise chain deals, blind-community distribution blitz, platform integrations); O1 wins because it is the only one with a proven paying buyer (Good Food Talks precedent), an active forcing function (2025 ADA lawsuit wave targeting restaurant menu PDFs), a defense against free AI (restaurant confirmation is the one thing Be My AI cannot replicate), and a direct fix for the app's own hardest problem (inferred, hedged menu data). The document includes validation-before-code steps, a lean build order, explicit do-not-build list, legal-positioning cautions, and a complete implementation prompt for the next Fable run.

**Step 6 — wrap-up.** No product code was changed, per the brief. Committing the two documents and opening a draft PR.

---

## Follow-up run — 2026-07-06 (afternoon): master to-do compilation

User request: merge the two independent reports — this session's Fable strategic analysis + July-3 audit, and the ChatGPT/Codex report — into one easy-to-implement master list, then extend it with more problems and value ideas. A continuation is scheduled for exactly 2h50m after this run started (trigger trig_019Zp8BPJav5RnUhEYUMejyP); if the main deliverable is done by then, that run expands the list by another 25 items.

**Done in this run:**
- Recovered the full July-3 audit findings from git history (commit e029b41): ranked S1 (safety/trust), S2 (core-loop), S3 (friction) findings with exact file/line locations.
- Cross-checked against the ChatGPT/Codex report the user pasted — its six headline issues map to audit findings S1-1, S2-1, S1-2, S1-3, S1-4, S2-4/S2-5; the two reports agree on what blocks real-user testing.
- Created **TODO.md** at the repo root, the single master file: Top 20 fixes ranked most-important-first (each with problem, why, exact files/lines, fix direction, and done-when criteria), then 25 more problems, then 25 value ideas (product/business/code/customer discovery). Items 1–9 are the "trust and safety pass" both reports say must precede real blind-user testing.
- Verified one Codex claim in the working tree: the "Safe for you" shellfish copy exists in THREE marketing files (website/index.html:578, public/website/index.html:577, menuvoice-site/v3/index.html:63) — recorded as TODO item 21.
- Nothing implemented yet by design: this run's deliverable is the compiled, ranked, implementable queue. TODO.md items 1–9 are sized as copy/gating fixes, not architecture.

**Scheduled continuation (+2h50m, fired 2026-07-07 00:26 UTC as planned):** verified the deliverable was complete and pushed, then expanded TODO.md with Part 5 (items 96–120) — haptic/braille/speech-rate interaction channels, dietary filters beyond allergens, numbered dish references for STT accuracy, testability infrastructure (preview-env keys, canned demo mode, session-replay viewer, shared API contracts), untouched distribution channels (ADA-defense law firms, vocational-rehab agencies, an accessible-dining-night event), and long-game data positioning (licensing rights in the first restaurant contract, schema.org markup, AI-agent readiness of verified pages). TODO.md now totals 120 items. Committed and pushed to the same branch; PR #8 carries everything.
