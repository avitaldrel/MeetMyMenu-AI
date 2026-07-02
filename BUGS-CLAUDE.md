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
