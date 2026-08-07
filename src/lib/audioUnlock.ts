// iOS/Safari (and Chrome autoplay policy) block ALL programmatic audio until
// the first one happens inside a real user gesture. That means our TTS,
// earcons, and SpeechSynthesis are all silent until we "unlock" them once,
// synchronously, from a tap/click.
//
// Call unlockAudio() from the FIRST button the user taps on each screen flow
// (e.g. "Let's begin", "New restaurant", "Tap to talk"). It is idempotent and
// cheap after the first run, so calling it on every tap is fine.
//
// What it does, all inside the gesture:
//   1. Creates/resumes a shared AudioContext (earcons reuse it).
//   2. Plays a 1-sample silent buffer to satisfy the autoplay gate.
//   3. Primes SpeechSynthesis with an empty utterance so later browser-voice
//      fallback speech (fired from timers, NOT gestures) is allowed to speak.
//   4. Plays + pauses a muted <audio> so later `new Audio(blobUrl).play()`
//      (OpenAI TTS, also fired outside a gesture) is permitted.

let sharedCtx: AudioContext | null = null;
let unlocked = false;
let primerAudio: HTMLAudioElement | null = null;

/** The shared AudioContext, created lazily. Earcons should use this. */
export function getAudioContext(): AudioContext | null {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!sharedCtx) sharedCtx = new Ctx();
    if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
    return sharedCtx;
  } catch {
    return null;
  }
}

export function unlockAudio(): void {
  // Priming is a ONE-TIME gate. Re-running it on every tap was measurably
  // costly and, on iOS, actively harmful: speechSynthesis is the same engine
  // VoiceOver speaks through, so touching it mid-gesture contends with
  // VoiceOver's own activation feedback — the reported symptom of a double-tap
  // taking "a while before I hear the usual click". Priming SpeechSynthesis is
  // lib/speech.ts's job anyway (it guards with _ttsPrimed and never cancels),
  // so this module no longer touches it at all.
  //
  // The AudioContext still gets resumed on every call: iOS suspends it when
  // the app is backgrounded, and resuming is cheap and idempotent.
  const ctx = getAudioContext();
  if (unlocked) return;

  try {
    if (ctx) {
      // Silent buffer through the context satisfies the autoplay gate.
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch {}

  try {
    // Prime an <audio> element so later blob playback (OpenAI TTS) is allowed.
    if (!primerAudio) {
      primerAudio = new Audio();
      primerAudio.muted = true;
    }
    primerAudio.play().then(() => primerAudio?.pause()).catch(() => {});
  } catch {}

  unlocked = true;
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}
