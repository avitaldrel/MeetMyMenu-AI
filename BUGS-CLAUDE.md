# Bug tracker (Claude session)

Bugs and feature requests reported by the user, tracked here as they're found
and fixed. Each entry links to the file(s) that changed and how it was
verified.

Branch: `side` (local, not yet pushed).

---

## Fixed

### 1. Login mic required a second tap to stop recording
**Reported:** email mic on login screen didn't auto-stop; users didn't know
they had to tap "Done speaking" again.
**Fix:** `src/screens/LoginScreen.tsx` — switched to `watchForSilence` (3s
quiet, 20s max), same one-tap flow already used in Onboarding/Settings.
**Verified:** tested locally — mic auto-stops after 3s of silence and fills
the email field without a second tap.

### 2. Voice transcription failed with Cartesia audio provider
**Reported:** "Sorry, I had trouble hearing that" on every voice input when
`VITE_AUDIO_PROVIDER=cartesia`.
**Fix:** `src/lib/openai.ts`, `api/transcribe.ts` — client always sends
`model=whisper-1`; server sanitizes/rewrites the model field before falling
back to OpenAI, instead of forwarding an OpenAI-incompatible model name.
**Verified:** tested locally with a real API key — transcription succeeds.

### 3. AudioContext not unlocked before voice-activity detection (VAD) starts
**Reported:** (found during fix #1/#2 testing) mic sometimes read silence and
never auto-stopped until the 20s ceiling.
**Fix:** `src/screens/LoginScreen.tsx` — call `unlockAudio()` synchronously in
the tap handler, before starting the recognizer, so the shared AudioContext is
already running when `watchForSilence` needs it.
**Verified:** tested locally — mic responds to actual speech instead of
always hitting the timeout.

### 4. Chat replies claimed a photographed menu was "found online" / "most current"
**Reported:** after scanning a physical menu with the camera, asking the
assistant about the menu produced responses implying it was sourced from the
internet and was the most up-to-date version — even though it came from a
photo taken in person.
**Fix:** `src/lib/openai.ts`, `src/screens/ConversationScreen.tsx` — every
chat turn's system prompt is now grounded in the same `MenuProvenance` facts
already used for explicit "where did this come from" answers
(`lib/provenance.ts`), with an explicit guard against online/recency claims
when `sourceType === 'photo'`.
**Verified:** tested locally — scanned a physical Popeyes menu, asked "Where
did you find the menu?", got: *"I found it from a photo of the physical menu
at Popeyes, not from the internet. It appears to be specific to that
location."*

### 5. Auto-capture didn't guide the user on distance or tilt/rotation
**Reported:** the guided scanner would let the user take a photo extremely
close to the menu, or crooked/sideways, without any coaching to fix framing —
it would just fire the shutter on whatever was in frame.
**Fix:** `src/lib/scanner.ts` — extracted the per-frame analysis into a pure,
unit-testable `computeFrameMetrics()` function and added three new signals:
  - **Too close** — the detected content's bounding box touches opposite
    frame edges (page is being cropped by the camera).
  - **Too far** — the bounding box is small relative to the frame (menu looks
    tiny/distant).
  - **Skewed/tilted** — mean edge-gradient angle offset from the nearest axis
    (0°/90°) exceeds 12°, using a signed-gradient orientation heuristic.

  These three new `ScanState`s (`tooClose`, `tooFar`, `skewed`) sit in the
  coaching priority chain right after "no menu detected" and before blur/
  motion, with staged coaching messages (mirrors the existing dark/glare/blur
  pattern) and **no best-shot bypass** — a badly framed photo is more likely
  to fail menu extraction than a slightly soft one, so capture is blocked
  until the user fixes it (or the existing 20s struggle timeout hands off to
  manual capture, same safety net as every other state).

  **Known limitation (by design, documented in tests):** a page rotated
  exactly 90° (phone held sideways) is mathematically indistinguishable from
  level using local edge-gradient orientation alone — both read as "axis
  aligned," just on swapped axes. True 90° rotation detection needs document
  boundary/aspect-ratio detection, out of scope for this lightweight
  per-frame heuristic. Since the app is portrait-locked, users are much more
  likely to hold the phone at a moderate, unintentional tilt than a
  deliberate 90° turn, so this fix targets that real case.

**Verified:**
  - `npm test` — 9 new unit tests in `tests/scanner.test.ts`, synthesizing
    grayscale frames with known bounding boxes and rotation angles:
    - well-framed + level → no warning
    - content bleeding to frame edges → flagged too close
    - small centered content → flagged too far
    - ~20° and ~35° rotation → flagged skewed, increasing with angle
    - exact 90° rotation → explicitly documents the known blind spot
    - blank frame → no false positive (defers to existing "searching" state)
    - motion metric sane on first vs. subsequent frames
  - `npx tsc --noEmit` — clean
  - All 30 project tests pass (21 pre-existing + 9 new)
  - Not yet verified against a live camera — CaptureScreen wiring only needed
    the new `ScanState` values (`onState` is generic, no exhaustive switch to
    update), so no CaptureScreen.tsx changes were required. **Manual
    live-camera verification still recommended before shipping**, since the
    unit tests exercise the math, not the real capture loop end-to-end.

### 6. Camera didn't default to a wide (0.5x) zoom
**Reported:** requested the camera start at 0.5x zoom by default so more of
the menu fits in frame without backing away.
**Fix:** `src/lib/camera.ts` — added `zoom: { ideal: 0.5 }` as a soft hint to
the initial `getUserMedia` constraints, so browsers/devices with an
ultra-wide lens have the best chance of starting on it. `src/screens/
CaptureScreen.tsx` — the initial zoom now explicitly targets 0.5x (clamped to
whatever the device's native zoom range actually supports) instead of just
using the hardware's reported minimum.
**Known limitation:** true sub-1x zoom requires a physical ultra-wide lens
exposed through the standard `zoom` capability — most single-lens cameras
(most desktop webcams, some phones/browsers) cannot go below 1x, and there is
no way to digitally fake a wider field of view than the sensor's native
capture. On unsupported hardware this silently falls back to 1x, same as
before.
**Verified:** `npx tsc --noEmit` clean, all 30 tests still pass (no test
coverage possible here — this is a hardware capability negotiation, not pure
logic). **Needs manual verification on a real phone with an ultra-wide lens**
— desktop testing cannot show this working.

### 7. No quality check after taking or uploading a menu photo
**Reported:** asked for a way to test image quality while taking photos, or
after, so the user knows whether to go back and take more.
**Context:** the live auto-capture scanner already coaches for lighting/blur/
framing WHILE shooting (see #5), but that only applies in auto mode. Manual
"Take photo" shots and uploaded library photos got zero quality feedback —
a real gap for a user who can't glance at a thumbnail to judge a bad photo.
**Fix:**
  - `src/lib/scanner.ts` — exported the tuned thresholds (`LUM_DARK`,
    `GLARE_FRAC`, `SHARP_MIN`, `EDGE_MIN`, `TOO_FAR_BBOX`, `SKEW_WARN_DEG`) so
    they're one shared source of truth for both live coaching and post-
    capture checks.
  - `src/lib/photoQuality.ts` (new) — `evaluateQuality()` is a pure function
    (unit-testable) that turns frame metrics into a verdict (`dark`, `glare`,
    `blurry`, `tooClose`, `tooFar`, `skewed`, or `noContent`).
    `assessPhotoQuality()` is the DOM-dependent wrapper: decodes a captured/
    uploaded JPEG, downsamples it to the same analysis scale the live
    scanner uses, and runs it through the same `computeFrameMetrics()` used
    for live coaching. Fails open (reports "ok") on any decode error — a
    quality check must never block the capture flow.
  - `src/screens/CaptureScreen.tsx`:
    - Every photo (manual, auto-captured, or uploaded) is now assessed
      immediately, and any issues are spoken/announced right after capture,
      e.g. *"Photo 3 captured. This photo looks blurry. Consider retaking
      it, or tap Read menu to continue."*
    - New **"Retake last photo"** button removes only the most recent shot so
      the user can redo just that one without starting over.
    - Tapping **"Read menu"** when any photo is flagged now announces a
      one-time confirmation (*"2 of your 5 photos may have quality
      problems... tap Read menu again to continue anyway"*) before
      proceeding — same two-tap-confirm pattern already used elsewhere in
      the app (Saved delete, Settings sign-out), so a flagged batch is never
      silently sent to the paid OCR call.
  - **Deliberately not built:** a visual thumbnail gallery to browse "which
    photo has issues." This is a voice-first accessibility app; a thumbnail
    grid is not usable by the target audience, so the fix is spoken feedback
    plus a same-photo redo, not a visual review screen.
**Verified:**
  - `tests/photoQuality.test.ts` — 9 new unit tests on `evaluateQuality()`
    covering each issue code individually, multiple simultaneous issues, and
    the no-content short-circuit.
  - `npx tsc --noEmit` — clean.
  - All 39 project tests pass (30 pre-existing + 9 new).
  - **Not yet manually verified in the browser** — please test: take a
    deliberately bad photo (very close/dark/tilted) via "Take photo," confirm
    it's flagged and spoken; upload a good + bad photo together and confirm
    only the bad one is called out; tap "Retake last photo" and confirm only
    the last photo disappears; tap "Read menu" with a flagged photo present
    and confirm the confirmation message, then tap again to proceed.

### 8. Allergy warning spoken at the end of a dish instead of the start
**Reported:** the allergy warning should be at the start of the dish in
browse mode, not the end.
**Fix:** `src/lib/allergens.ts` — moved the dish-label composition (previously
a local, untested function inside `ConversationScreen.tsx`) into a new
exported `dishSpokenLabel()`. The allergen warning now comes FIRST, before
name/price/description/ingredients — a guest with a severe allergy should not
have to listen through the whole dish to reach the warning that tells them to
skip it. `src/screens/ConversationScreen.tsx` now imports and uses
`dishSpokenLabel()` instead of its old local `dishLabel()`.
**Verified:** 3 new unit tests in `tests/allergens.test.ts` — warning-first
ordering, no warning prefix when there are no other allergens, and that the
rest of the dish info still follows. All 42 project tests pass, `npx tsc
--noEmit` clean.

### 9. Browse mode toggle didn't bring the user down to the organized menu
**Reported:** tapping Browse mode should bring the user down to the organized
(browse) section of the page.
**Fix:** `src/screens/ConversationScreen.tsx` — `toggleSpeakMode()` already
called `.focus()` on the menu heading when entering Browse Menu, but relied
on the browser's implicit focus-scroll behavior, which is inconsistent
across browsers (especially Safari) for non-form elements. Now calls
`.focus({ preventScroll: true })` followed by an explicit
`.scrollIntoView({ behavior: 'smooth', block: 'start' })`, so the scroll is
guaranteed rather than incidental.
**Verified:** `npx tsc --noEmit` clean. Confirmed with a real Playwright
browser run (`test-bugfixes.mjs`) against the live dev server: the `.screen`
container's `scrollTop` moved from `0` to `611px` after tapping the toggle,
the "Menu categories" heading landed inside the viewport, and
`document.activeElement` was confirmed to be that heading (VoiceOver/focus
correctly lands there too).

### 10. Redundant TTS voice picker in Settings
**Reported:** remove the extra/redundant voice options in Settings.
**Fix:** `src/screens/SettingsScreen.tsx` — removed the 6-option TTS voice
picker (shimmer/nova/alloy/echo/fable/onyx radio group) and its now-unused
`VOICES` constant. Settings keeps the one voice-related control that matters
for accessibility: the "App voice" on/off toggle. `profile.ttsVoice` still
defaults to `'shimmer'` internally (`types.ts`'s `EMPTY_PROFILE`) — only the
UI for picking a different cosmetic voice was removed, not the underlying
default.
**Verified:** `npx tsc --noEmit` clean, all 42 tests pass. **Interpretation
call:** "over voice options" was read as "the excess/redundant voice
options" (the picker), as distinct from the essential "App voice" toggle —
flag if this wasn't the intended scope.

### 11. Unnecessary fluff text
**Reported:** remove text that isn't necessary, like added fluff.
**Fix:** `src/screens/HomeScreen.tsx` — removed the decorative marketing
tagline ("Point, ask, and order. The menu, read aloud and ready to talk.")
under the MenuVoice title. It added VoiceOver navigation overhead before the
actionable buttons without guiding any action.
**Scope note:** this was a full app-wide copy audit was NOT attempted here —
that's a larger task already tracked as backlog item B11 in
`FIXES-NEEDED.md` ("Copy audit for VoiceOver-first screens"). This fix
targeted the one clearly decorative, non-actionable piece of copy found
while working the other three bugs in this batch. Let me know if a fuller
pass across all screens is wanted.
**Verified:** `npx tsc --noEmit` clean, all 42 tests pass.

### 12. Onboarding used voice/mic for name and allergies, and had an extra welcome screen
**Reported:** turn off voice mode for allergies and name during onboarding — just have
them type it; also remove the screen that says "Start Menu Voice" shown right after
entering an email, before the app starts.
**Fix:** `src/screens/OnboardingScreen.tsx` — rewritten:
  - Removed the `'intro'` step (the "Welcome to MenuVoice... Start setup" screen).
    Onboarding now goes straight from Login into the name question.
  - Replaced `VoiceStep` (mic recording + Whisper transcription) with a plain
    `TypeStep` (text input only) for both the name and allergies questions. Name and
    allergies are the two fields where a mishearing is costliest (a wrong allergen is
    a safety issue, see bug 8 and `FIXES-NEEDED.md` B8), so voice input on these two
    specific fields is removed — screen readers can still use the device's own
    dictation keyboard, this only removes the app's separate in-app recording flow.
  - `finish()` still runs the typed input through the existing `cleanName()` /
    `parseList()` / `normalizeAllergens()` safety pipeline, unchanged.
**Verified:** `npx tsc --noEmit` clean, all 42 tests pass (no test changes needed —
this is a UI-only removal, no new pure logic). Walked the full flow in a live
Chromium session against the local dev server: fresh login → lands directly on
"What should I call you?" (no intro screen, no mic button) → typed "Sarah" → Next →
"Any food allergies?" (no mic button) → typed "peanuts" → Finish → landed on Home →
confirmed in Settings that name "Sarah" and allergy "peanuts" both persisted
correctly.

### 14. Resume Voice Conversation stayed silent when voice was "paused"
**Reported:** on the conversation screen, if the person pauses the voice and then
clicks Resume Voice Conversation, it won't play, because voice is paused. That is
the one scenario that should override the pause and play.
**Root cause:** there were TWO independent silencers: the global Pause state
(PauseContext) and a persistent "App voice" profile gate inside `speech.ts`
(`_appVoiceOn`, set by the Settings toggle and loaded from localStorage). Resume
only cleared the first one; if the profile gate was off, `speak()` returned
early no matter what the user tapped, so resuming looked like it did nothing.
**Fix:** `src/lib/speech.ts` — removed the `_appVoiceOn` gate entirely
(`setAppVoice`, `isAppVoiceOn`, the localStorage read). The pause state is now
the ONE voice switch, and resuming the conversation always brings speech back.
`src/state/ProfileContext.tsx` and `src/types.ts` dropped the appVoice wiring.
**Verified:** live Chromium run — opened Demo Menu, tapped the floating Pause
Voice button (both buttons flipped to their resume labels), tapped Resume Voice
Conversation, and the phase indicator immediately showed "MenuVoice is
speaking..." before reopening the mic. All 48 tests pass, tsc clean.

### 15. No guidance about screen readers or the Pause button in conversation mode
**Reported:** (a) entering conversation mode should mention, as a short text
note, that the user can turn VoiceOver off and speak more naturally, though
they don't have to; (b) somewhere should explain that Pause silences the voice
across the app and clicking again resumes.
**Fix:** `src/screens/ConversationScreen.tsx` — one short `role="note"`
paragraph under the mode toggle covering both: "In Conversation Mode you can
turn your screen reader off and talk naturally, if you prefer. You do not have
to. If voices talk over each other, tap Pause Voice at the top to silence
MenuVoice. Tap it again to resume."
**Verified:** live Chromium run — note renders on the conversation screen for
the Demo Menu; visible to sighted users and reachable as a note by VoiceOver.

### 16. App voice talked outside conversation mode
**Reported:** turn off all the talking parts in anything that's not
conversation mode; everything can be read by VoiceOver in text.
**Fix:** app TTS now exists ONLY on the conversation screen.
  - `src/screens/LoginScreen.tsx`, `OnboardingScreen.tsx`, `SettingsScreen.tsx`,
    `SavedScreen.tsx`, `FindScreen.tsx` — every `speak()` call removed; each
    message already had (or now has) a `role="status"` aria-live region, so
    VoiceOver announces it from the DOM instead.
  - `src/screens/CaptureScreen.tsx` — all `speak()`/`coach()` scanner coaching
    removed; the coaching live region (previously silenced while app voice was
    on) is now always `aria-live="polite"`. Earcons (ticks, shutter) remain as
    non-speech cues.
  - `src/lib/speech.ts` — `coach()`/`stopCoach()` deleted (dead code).
  - FindScreen's "What are you doing?" button now re-fires the live region
    (clear, then re-set) instead of speaking, since aria-live only announces
    on change.
**Verified:** `grep` proves `speak`/`createStreamingSpeech` are imported only
by `ConversationScreen.tsx` (CaptureScreen/PauseContext import only
`stopSpeaking`), so no other screen CAN talk. Live Chromium walk of login →
onboarding → home → settings with a clean console. All 48 tests pass.

### 17. Remove the remaining voice option in Settings
**Reported:** remove the voices options (follow-up to bug 10, which removed
the six-voice picker; the "App voice" on/off toggle remained).
**Fix:** `src/screens/SettingsScreen.tsx` — App voice toggle removed. With
bugs 14/16, it was redundant: nothing outside conversation talks anymore, and
the global Pause Voice button covers conversation. Settings now has zero
voice-related controls.
**Verified:** live Chromium run — Settings page shows no App voice card.
`appVoice` removed from `UserProfile` (old stored profiles simply carry an
ignored extra key). All 48 tests pass, tsc clean.


---

## How to verify a fix locally

1. `cd "D:\8th SEMESTER\menu voice"`
2. `npm test` — runs the full pure-function test suite
3. `npx tsc --noEmit` — type-check
4. `npm run dev` — starts the dev server at `http://localhost:5173`
5. Manually walk the affected screen/flow in Chrome

## Template for new bugs

```
### N. <short title>
**Reported:** <what the user described>
**Fix:** <files changed, what changed>
**Verified:** <tests run, manual steps, what was observed>
```
