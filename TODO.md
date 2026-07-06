# TODO — MenuVoice Master Fix & Value List

Compiled 2026-07-06 from four sources: the Fable unattended accessibility audit of
2026-07-03 (git history, commit e029b41), the ChatGPT/Codex strategic report and
audit summary, FIXES-NEEDED.md / REVIEW.md open items, and the strategic decision
document FABLE-ONE-WINDOW-RUNBOOK.md. Where the two AI reports overlap, the item
is marked **[both agree]** — those are the highest-confidence calls.

How to use this file: work the Top 20 in order. Each item says what is wrong, why
it matters, exactly where the code is, how to fix it, and how you know it is done.
Items 1–9 are the "trust and safety pass" both reports say to do before any real
blind-user testing.

---

## PART 1 — TOP 20 FIXES (most important first)

### 1. False "your allergen dishes are hidden" claim [both agree — #1 in both reports]
- **Problem:** Browse mode announces "Dishes that may contain your allergens ({list}) are hidden" for the user's *entire* allergy list, but detection only covers 9 groups (dairy, egg, gluten, peanut, tree nut, soy, fish, shellfish, sesame). A user with a mustard, celery, or sulfite allergy is told those dishes are hidden — none are. This is a false safety claim, worse than no claim.
- **Where:** `src/screens/ConversationScreen.tsx:153-156` (the claim), `src/lib/allergens.ts` (what's actually detectable), `src/util.ts:36-41` (normalizer accepts undetectable allergens).
- **Fix:** Split the user's allergy list into detectable vs undetectable. Only claim hiding for detectable ones; explicitly say "I cannot screen for {mustard, celery} — please ask the restaurant."
- **Done when:** a profile with `mustard` hears the cannot-screen sentence; a unit test locks the wording.

### 2. VoiceOver gets spoken into the open mic — the app answers itself [both agree]
- **Problem:** The sr-only conversation reply summary (`aria-live="polite"` + `aria-atomic`) re-announces the entire growing reply on every streamed token; VoiceOver's speech is still playing when the mic auto-opens 150ms after the earcon, so VoiceOver's voice lands in the recognizer and the app answers a question the user never asked. This is the P0-2 regression and the single most likely abandon-point.
- **Where:** `src/screens/ConversationScreen.tsx:725-731` (region), `:387-391` (mic auto-open).
- **Fix:** Gate the reply-summary region on `!isAppVoiceOn()` (like the Capture coach region); keep it `aria-live="off"` from the moment a reply starts streaming until after the mic closes; announce once at reply end, not per token; add a short guard delay before mic open if a live-region update just fired.
- **Done when:** headless dogfood shows zero polite-region mutations between reply-start and mic-close; verified on a real iPhone (item 18).

### 3. Silent allergy autocorrect can remap to a DIFFERENT allergen [both agree]
- **Problem:** Edit-distance ≤2 correction on words >5 chars means dictated "custard" silently becomes "mustard". Settings announces corrections after saving; Onboarding throws the corrections array away entirely — the user never learns their allergy list was changed.
- **Where:** `src/util.ts:83-88` (`correctAllergen`), `src/screens/OnboardingScreen.tsx:58`.
- **Fix:** When the corrected word differs from input by more than trivial spelling (or maps to a *different* known allergen), ask: "Did you mean mustard?" and require yes/no. Surface corrections in onboarding exactly as Settings does. Add tests for `correctAllergen`/`normalizeAllergens` (there are none).
- **Done when:** "custard" prompts confirmation instead of silently saving mustard; onboarding announces every correction; tests pass.

### 4. Pasted-URL menus save and open with zero confirmation, and can overwrite a good save [both agree]
- **Problem:** The URL path calls `saveRestaurant` + `navigate` immediately — no confirm card (the name-search path has one). A same-name/same-location save *replaces* the existing entry, so one bad URL parse can destroy a good saved menu. And the confirm card is touch-only — the spoken "Is this the right place?" cannot be answered by voice (FIXES-NEEDED B10).
- **Where:** `src/screens/FindScreen.tsx:181-196` (URL path), `:307-334` (confirm card), `src/lib/storage.ts:138-140` (overwrite).
- **Fix:** Route the URL path through the same confirm card; add voice yes/no to the confirmation (speech recognition already exists in the codebase); on same-name save, keep both or ask before replacing.
- **Done when:** pasting a URL shows/speaks the confirm card; saying "yes" opens it; a duplicate save never silently overwrites.

### 5. "Add more photos" launders provenance — old third-party menu becomes "official, checked today" [both agree]
- **Problem:** Supplementing an incomplete third-party menu with one photo re-stamps the merged result `sourceType:'photo', official:true, checkedAt:now`, and re-judges `incomplete` from the new photos alone while keeping a stale `incompleteReason`. An old DoorDash menu plus a dessert-page photo reads as "an official menu, checked today."
- **Where:** `src/screens/CaptureScreen.tsx:354-380`, `mergeMenus`.
- **Fix:** Merged menus keep the *weakest* provenance of their parts: preserve original sourceType/official/checkedAt, set completeness from the union, and say "parts of this menu came from different sources."
- **Done when:** supplementing a third-party menu never upgrades it to official; a test covers the merge rule.

### 6. Photo-path menus can crash the app or speak a raw TypeError [both agree]
- **Problem:** The client photo path validates only `categories.length > 0`; a category without `items` throws, and the caught message — "Cannot read properties of undefined (reading 'length')" — is SPOKEN to a blind user. If it reaches render, `MenuDocument` crashes with no React error boundary → silent white screen (the worst possible failure for a VoiceOver user).
- **Where:** `src/lib/openai.ts:118-129`, `src/screens/CaptureScreen.tsx:355`, `src/main.tsx`/`src/App.tsx` (no boundary). Server-side `sanitizeMenu` already exists at `api/_menuCore.ts:492-527` — the client just doesn't use an equivalent.
- **Fix:** Run a client-side `sanitizeMenu` on every parse result before use; add a React error boundary that *speaks and displays* a friendly recovery message.
- **Done when:** a malformed parse produces "I had trouble reading that menu — try another photo" and never a stack-trace sentence or white screen.

### 7. Raw error text reaches speech on the Find path [both agree]
- **Problem:** `const message = e?.message ?? fallback` — every Error has a message, so the fallback never fires; restaurant Wi-Fi drop makes the app say "Failed to fetch." Also the `found:false` branch of find-menu returns model-generated text verbatim, and the localhost-only "Set OPENAI_API_KEY in Vercel environment variables" developer copy ships in the user-facing bundle.
- **Where:** `src/screens/FindScreen.tsx:231` and `:170`; `api/find-menu.ts:176-181`.
- **Fix:** Allowlist of friendly messages: map known error shapes to written copy, default to one generic recovery sentence. Replace model `reason` with fixed copy. Strip dev-only copy from production build.
- **Done when:** no code path can speak text that wasn't written by a human.

### 8. iOS: speech randomly never plays when TTS falls back to the browser voice
- **Problem:** `speak()` → `stopSpeaking()` → `speechSynthesis.cancel()` then speaks in the same tick; iOS Safari silently swallows utterances issued in the same task as `cancel()`. Whenever OpenAI TTS fails, onboarding prompts, Find intro, and error messages randomly never play — on the primary platform. `coach()` already got the 60ms-deferral fix; `speak()` did not.
- **Where:** `src/lib/speech.ts:116` (cancel), `:200-213` (`playBrowser`), fix pattern at `:254-265`.
- **Fix:** Apply the same setTimeout(~60ms) deferral inside `playBrowser()`.
- **Done when:** code matches the coach() pattern; verify on a real iPhone with TTS forced to fallback.

### 9. "nuts" only maps to tree nuts — peanut dishes are NOT blocked; allergen keywords miss common carriers
- **Problem:** A user who says "nuts" gets tree-nut screening only; peanut dishes pass. Keyword lists miss alfredo/queso/ricotta (dairy), tortilla/ramen/tempura (gluten), mahi/unagi (fish) — "Chicken Alfredo" draws no dairy disclaimer.
- **Where:** `src/util.ts:46-47` vs `src/lib/allergens.ts:55` and keyword lists in `allergens.ts`.
- **Fix:** "nuts" expands to peanut + tree nut; extend carrier keyword lists; add tests for each new mapping.
- **Done when:** "nuts" blocks peanut dishes; "Chicken Alfredo" carries a dairy may-contain disclaimer.

### 10. Pause Voice doesn't actually pause everything
- **Problem:** `speak()` has no paused check — navigating while paused makes the next screen's intro talk anyway. Dictation recorders on Login/Onboarding/Settings never register a stop hook, so "Pause Voice" mid-dictation keeps the mic recording up to 30s.
- **Where:** `src/lib/speech.ts` (`speak`), `src/screens/{Login,Onboarding,Settings}Screen.tsx` (recorders), `PauseProvider`.
- **Fix:** Check paused state at the top of `speak()`; call `registerStopListening` from every MediaRecorder flow.
- **Done when:** with voice paused, no screen speaks on entry and no mic stays open.

### 11. Safety-adjacent messages exist only as speech — gone if app voice is off or it races unmount
- **Problem:** The onboarding farewell that CONFIRMS WHICH ALLERGIES WERE SAVED races its own unmount and exists in no DOM node — the user may never learn what was stored. Also speak-only: Login nudges/welcome/failure, Saved count, Find "What are you doing?".
- **Where:** `src/screens/OnboardingScreen.tsx:53-66`, `LoginScreen.tsx:56,72,75,82,151`, Find `:296`.
- **Fix:** Every user-relevant message goes through the announce pattern (DOM status region + optional speech). Move the allergy confirmation *before* navigation, or announce it on the next screen.
- **Done when:** with app voice OFF and VoiceOver on, every message above is announced.

### 12. One announcement model — screen entry is still up to three voices (B6)
- **Problem:** With app voice on + VoiceOver: mount-time `speak()` + VoiceOver reading the focused `<main>` + the global page-status region all fire on every navigation. The `announce()` pattern double-speaks app-wide.
- **Where:** `src/App.tsx:87-94` (global region), every screen's mount speech.
- **Fix:** Implement the FIXES-NEEDED B6 design: one channel per event — if app voice speaks it, the live region stays silent (gate on `isAppVoiceOn()` everywhere, as Capture's coach region already does). This resolves items 13's sibling issues wholesale.
- **Done when:** each navigation produces exactly one announcement per output channel the user has enabled.

### 13. Capture screen double-speaks half its messages (B4 incomplete)
- **Problem:** The coach region is gated but the second always-live region also receives messages that are ALSO spoken: photo confirmations, the every-5s analysis reassurance, zoom announcements, upload results.
- **Where:** `src/screens/CaptureScreen.tsx:476` (gated) vs `:480` (not gated).
- **Fix:** Apply the same `isAppVoiceOn()` gate to the second region.
- **Done when:** with app voice on, capture messages are spoken once.

### 14. Browse-mode heading rotor no longer matches the documented model
- **Problem:** Categories render as collapsed `aria-expanded` buttons under one h2; a heading-rotor user finds nothing between the restaurant name and "Menu categories" until they expand a category. The celebrated "h2 category → h3 dish" model (PROGRESS.md) no longer matches shipped structure.
- **Where:** `src/screens/ConversationScreen.tsx` MenuDocument.
- **Fix:** Either restore real category headings (h2 with a button inside, disclosure content following) or document/announce the disclosure model in the browse-mode guidance speech so users know to use buttons, not headings.
- **Done when:** rotor sweep of a collapsed menu reaches every category; browse guidance matches reality.

### 15. Long waits hard-`disabled` the controls under VoiceOver focus
- **Problem:** Find (during the up-to-60s search) and Capture (all five controls during analysis) use `disabled`, dropping VoiceOver focus to body for the whole wait. Mic buttons on Settings/Login/Onboarding have the same issue. The `aria-disabled` + no-op pattern was applied only to Conversation.
- **Where:** `src/screens/FindScreen.tsx`, `CaptureScreen.tsx`, `SettingsScreen.tsx`, `LoginScreen.tsx`, `OnboardingScreen.tsx`.
- **Fix:** Replace `disabled` with `aria-disabled` + no-op handler (copy the Conversation pattern).
- **Done when:** VoiceOver focus survives a full search/analysis wait.

### 16. Settings dictation narrates into its own microphone
- **Problem:** "Listening for your name" is announced AFTER the recorder opens — the app transcribes its own prompt.
- **Where:** Settings dictation flows (`src/screens/SettingsScreen.tsx`).
- **Fix:** Speak/announce first, wait for speech end (or a fixed delay), then open the recorder — the Conversation screen's earcon+delay pattern.
- **Done when:** transcripts never contain the prompt text.

### 17. Chat can recommend blocked dishes and truncate mid-allergen-warning
- **Problem:** The LLM receives the full menu including dishes hidden for allergens — the flag-first rule is prompt-only. The 220-token reply cap can cut a reply off in the middle of a warning.
- **Where:** `src/lib/openai.ts` (`buildSystemPrompt`, chat call), `api/chat.ts`.
- **Fix:** Filter blocked dishes out of the menu payload sent to chat (keep a count so the model can say "2 dishes hidden"); either raise the cap or instruct warning-first + detect truncation and re-ask.
- **Done when:** a blocked dish name never appears in a reply; no reply ends mid-sentence on an allergen warning.

### 18. Real-device VoiceOver test — the gate everything above waits on (D4)
- **Problem:** Every finding tagged "verify on device" is unverified; the audit is headless-browser + code reading. Nothing substitutes for a real iPhone with VoiceOver.
- **Fix (operational, not code):** After items 1–8 land: deploy, then run the audit's 7-scenario VoiceOver script (documented in PROGRESS.md "Manual VoiceOver test scenarios") on a real iPhone. Ideally recruit 1–2 blind testers (see Ideas 3–4).
- **Done when:** a written test log exists for all 7 scenarios on device.

### 19. Production truth check: incomplete flag, Browserless token, chain-site smoke (D3 + ops)
- **Problem:** Whether `menu.incomplete` survives to production JSON was never verified; `BROWSERLESS_TOKEN` appears dead so JS-heavy chain sites (Toast/Square pages) fail via URL; SMOKE-RESULTS chain 404s never re-checked.
- **Fix:** With the deployed URL: curl a known-partial menu for `incomplete`; renew the Browserless token (or remove the dead path and rely on find-by-name); re-run `scripts/smoke-restaurants.mjs`; delete dead `api/scrape.ts` (confirmed unused).
- **Done when:** smoke matrix green or failures have honest user-facing copy.

### 20. Telemetry multi-tab and pre-init races (REVIEW #16 / C3)
- **Problem:** Two tabs restore the same localStorage queue and double-send; events tracked before `initTelemetry()` are discarded. Your usage data — the thing every product decision depends on — undercounts and double-counts.
- **Where:** `src/lib/telemetry.ts:113-117`.
- **Fix:** Merge queues (`[...restore(), ..._queue]`), namespace the queue key per session, clean stale keys on init.
- **Done when:** two-tab test sends each event exactly once.

---

## PART 2 — 25 MORE PROBLEMS WORTH FIXING

21. **Marketing site says "Safe for you" about shellfish** — verified in three files: `website/index.html:578`, `public/website/index.html:577`, `menuvoice-site/v3/index.html:63`. Directly contradicts the app's never-say-safe rule; a lawyer or blind user who sees it loses trust instantly. Replace with the app's own wording ("The restaurant lists no shellfish in the carbonara") in all three. Fix the copy today.
22. **B13 numeric opening line** — "I found 2 sections…" instead of restaurant-first copy; counts also push allergen/provenance notes later in the opening.
23. **A1 preview-vs-capture framing mismatch** — code-complete but never verified on a real phone; blind users frame to what they hear coached.
24. **A2 zoom** — real iPhone fallback / Android native zoom never device-checked.
25. **A3 landscape capture** — same: CSS landed, never verified on a rotated device.
26. **No rate limiting on expensive endpoints** — anyone can hammer `/api/find-menu` (LLM + web search per call) and run up the OpenAI bill; add per-IP throttle.
27. **REPORT_KEY passes in URL query strings** — dashboard/morning/report keys end up in logs and browser history; move to a header or POST.
28. **`api/sync.ts` is last-write-wins** — two devices can silently lose profile allergies (safety-adjacent); add updatedAt comparison or field merge.
29. **No profile schema versioning/migration** — any breaking change strands localStorage users; add a version field + migration map now, while cheap.
30. **Saved-menu storage has no eviction strategy** — `storage_quota` failures are tracked but nothing frees space or tells the user what to delete.
31. **puppeteer is a production dependency** — heavy install for serverless deploys; it's only used by scripts/tests, move to devDependencies.
32. **Scanner thresholds still "tuned on theory"** — LUM_DARK/SHARP_MIN/EDGE_MIN were never adjusted from the `capture/guidance` telemetry that exists for this purpose.
33. **Find analytics mislabel** — find-by-name results tracked as `source:'url'`, muddying the funnel you'd use to prioritize.
34. **Offline/dead-zone behavior** — restaurants are dead zones; no `navigator.onLine` detection, no service worker, voice turns just hang (IDEAS 7).
35. **GPS-assisted find missing** — ambiguous chains return the wrong location's menu; the phone knows the city (IDEAS 5).
36. **`hidePrices` not honored in browse mode** — MenuDocument renders prices regardless of the setting (IDEAS 11).
37. **No "continue with last restaurant" on Home** — reopening yesterday's place takes 4+ steps at the table (IDEAS 6).
38. **Cartesia voice path unverified** — `api/_cartesia.ts` + key rotation landed but CARTESIA-VOICE-TEST.md work was never confirmed in production; users may be silently on the slower/costlier path.
39. **No per-session cost telemetry** — you cannot state unit economics (OpenAI cost per menu session); log token usage per request to Postgres.
40. **Multi-language menus unsupported** — Spanish-language menus are common in NJ; parse works but speech/UX assumptions are English-only.
41. **No error alerting** — `_providerAlerts.ts` exists but confirm failures actually notify you; otherwise a dead OpenAI key means silent total outage until someone complains.
42. **Onboarding never mentions the app-voice toggle in DOM** — the first-launch hint exists only as speech; VoiceOver-first users suffer triple-speech until they stumble on Settings.
43. **Tap-anywhere-to-interrupt is inert under VoiceOver** — acceptable (labeled button remains) but the acceptance criterion will fail on device; update FIXES-NEEDED so no one re-litigates it.
44. **`speechRecognition.ts` (325 lines) vs recorder+Whisper duplication** — two speech-input stacks to maintain; consolidate or document which flows use which.
45. **Demo/seeded menu drift** — `demoMenu.ts` shape can drift from real parse output; derive it from a recorded real parse so demos don't lie.

---

## PART 3 — 25 VALUE IDEAS (product, business, code, customer discovery)

Ranked roughly by expected value. #1 is the strategic pick from FABLE-ONE-WINDOW-RUNBOOK.md — the full implementation prompt for it is in that file, section 10.

1. **MenuVoice Verified pilot** — hosted, restaurant-confirmed accessible menu page (`/m/{slug}`) restaurants pay for; verified data upgrades allergen answers and kills the scraping problem for participating restaurants. The one initiative that creates revenue, users, and trust at once.
2. **Founding-partner offer** — first 10–20 restaurants free-for-life/discounted for feedback + case study; a one-page pitch on the marketing site plus a QR table-tent generator.
3. **Customer-discovery sprint** — script + tracking sheet for 10 restaurant conversations and 5 blind-user/advocacy conversations (NFB NJ, Lighthouse orgs); the kill/continue evidence for #1 before writing code.
4. **Recruit 3–5 blind iPhone testers** — through NFB chapters/AppleVis; paid or thanked properly; this converts every "simulated tester" caveat in the audits into real evidence.
5. **"Tell the waiter" card** — order + allergies in large type + TTS playback for the handoff moment (IDEAS 4); the hardest unsolved moment at the table and a demo that sells the product in 10 seconds.
6. **Voice input for Find** — the only typed-entry path in a voice-first app; mic pipeline already exists (IDEAS 2; check PR #6/#9 partial work first).
7. **Allergen flags in the browsable menu** — per-item "may contain: peanuts — your allergy" lines in browse mode, not just chat (IDEAS 1).
8. **Wizard-of-Oz concierge verification** — "Request a verified menu" button; founder manually verifies within 24h. Tests demand for Verified with zero build cost and seeds the catalog.
9. **AppleVis + blind-community directory listings** — free, high-trust distribution; an AppleVis app entry with an honest description reaches exactly the target users.
10. **Demo video with VoiceOver** — screen-recorded real session for restaurant sales and community credibility; doubles as the case-study asset.
11. **Accessibility-effort report for restaurants** — auto-generated one-pager per verified restaurant (last checked, source, usage, issues fixed) — the proof-of-effort artifact both AI reports converged on; do NOT frame as ADA certification.
12. **North Star metric + weekly funnel ritual** — define "menus successfully ordered from" and review the existing dashboard funnel weekly; every fix above should move a number.
13. **LOI + Stripe payment link** — test pricing ($29–79/mo hypotheses) with a signable one-pager and a payment link before building any billing.
14. **Menu freshness re-check cron** — for verified restaurants, monthly automated re-fetch + diff + "confirm this is still right" email; retention machinery for the paid product.
15. **NJ Restaurant Association / local chamber partnership** — one endorsement converts cold outreach into warm intros; accessibility angle is an easy story for them.
16. **Grant funding scan** — assistive-tech/SBIR/state accessibility grants; a solo accessibility startup with real users is exactly what these fund; extends runway without dilution.
17. **Chain target dossier** — the 10 US chains most exposed on menu accessibility (existing lawsuits, PDF menus) with contact strategy; the O3 enterprise play, prepped cheaply now.
18. **"Near me" verified discovery** — location-aware list of verified restaurants; makes the app a *destination* ("where can I eat independently tonight?") rather than a utility.
19. **Share a captured menu** — Web Share API text export first, server share-links later (IDEAS 9); lets a blind user answer "what does this place have?" for a friend before arriving.
20. **TalkBack/Android pass** — audit + fix the top Android screen-reader issues; roughly doubles the addressable blind-user base for mostly-CSS/ARIA-level work.
21. **Cost-optimized voice stack** — finish Cartesia (or gpt-4o-mini-tts) as primary with per-session cost logging (problem #39); halving voice cost changes unit economics for the free consumer tier.
22. **Session save-and-resume across devices** — saved restaurants already sync; extend to in-conversation state so a dropped connection at the table doesn't restart the meal.
23. **Open-source the accessible menu renderer** — the rotor-correct MenuDocument as a tiny OSS package; SEO/credibility with a11y engineers and restaurant-platform devs, funnel to Verified.
24. **Email waitlist + monthly changelog note** — accessible signup on the marketing site; the blind community rewards products that communicate; costs an hour.
25. **Quarterly re-run of this audit loop** — re-run the unattended Fable audit + compile deltas into this file; the S1/S2 findings above were invisible to axe scans and will regress without a ritual.

---

## Progress log for this compilation

- 2026-07-06: Compiled from Fable audit (e029b41), ChatGPT/Codex report, FIXES-NEEDED.md, REVIEW.md, FABLE-ONE-WINDOW-RUNBOOK.md. Top 20 ranked; both AI reports agree on items 1–7 as the pre-user-testing blockers. Nothing here is implemented yet — this file is the queue.
- Next scheduled continuation: expand with 25 more items if the earlier parts are complete.
