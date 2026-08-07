// Work that runs on the tap path.
//
// Reported by Jonathan Mosen (National Federation of the Blind): "after I
// double-tap a button, it takes a while before I hear the usual click
// confirming that I have activated the control."
//
// Two things were doing avoidable work inline with every tap:
//   1. telemetry persisted the ENTIRE session queue to localStorage — a
//      synchronous disk write — on every single event, and re-read and
//      re-parsed the profile each time to stamp the address on it;
//   2. audio priming re-ran on every call despite being a one-time gate, and
//      part of what it re-ran was speechSynthesis — the same engine VoiceOver
//      speaks through on iOS.
//
// These tests pin the behaviour, not the wall-clock timing, so they stay
// meaningful on any machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal storage doubles. Only localStorage access is counted — the session
 * id legitimately touches sessionStorage once, and that is not the tap-path
 * cost under test.
 */
function installStorage() {
  const store = new Map<string, string>();
  let writes = 0;
  let reads = 0;
  const mk = (count: boolean) => ({
    getItem: (k: string) => { if (count) reads++; return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (count) writes++; store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
  (globalThis as any).localStorage = mk(true);
  (globalThis as any).sessionStorage = mk(false);
  // navigator is getter-only on modern Node, so assignment throws.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test' },
    configurable: true,
    writable: true,
  });
  return {
    writes: () => writes,
    reads: () => reads,
    resetCounts: () => { writes = 0; reads = 0; },
    store,
  };
}

test('a burst of tracked interactions does not write to storage on every event', async () => {
  const storage = installStorage();
  storage.store.set('menuvoice.profile.v1', JSON.stringify({ email: 'jmosen@nfb.org' }));
  const { track } = await import('../src/lib/telemetry.ts?case=burst');

  storage.resetCounts();
  for (let i = 0; i < 40; i++) track('ui', `tap_${i}`);

  assert.equal(
    storage.writes(),
    0,
    `40 taps caused ${storage.writes()} synchronous storage writes; the write must be deferred off the tap path`
  );
});

test('the signed-in address is not re-read from storage on every event', async () => {
  const storage = installStorage();
  storage.store.set('menuvoice.profile.v1', JSON.stringify({ email: 'jmosen@nfb.org' }));
  const { track } = await import('../src/lib/telemetry.ts?case=email');

  track('ui', 'warm'); // first call populates the cache
  storage.resetCounts();
  for (let i = 0; i < 40; i++) track('ui', `tap_${i}`);

  assert.equal(
    storage.reads(),
    0,
    `40 taps caused ${storage.reads()} profile reads; the address should be cached between events`
  );
});

test('deferred events still reach storage, so a crash cannot lose them', async () => {
  const storage = installStorage();
  const { track } = await import('../src/lib/telemetry.ts?case=persist');

  track('ui', 'deferred_write_probe');
  assert.equal(storage.writes(), 0, 'not written synchronously');

  await new Promise((r) => setTimeout(r, 2200)); // past the debounce window
  assert.ok(storage.writes() > 0, 'the queue must still be persisted shortly after');
  // Other cases in this file own their own module instance (and so their own
  // session id and queue key); search every queue for this test's own event.
  const queues = Array.from(storage.store.entries())
    .filter(([k]) => k.startsWith('mv.tel.queue'))
    .map(([, v]) => v)
    .join('\n');
  assert.match(queues, /deferred_write_probe/, 'the event should be in a persisted queue');
});

test('audio priming runs its one-time work exactly once, and never touches speechSynthesis', async () => {
  // speechSynthesis is VoiceOver's own engine on iOS. Touching it inside a tap
  // handler contends with VoiceOver's activation feedback, which is the
  // reported symptom. lib/speech.ts owns TTS priming; this module must not.
  let speechCalls = 0;
  let bufferSources = 0;
  (globalThis as any).window = {
    AudioContext: class {
      state = 'running';
      destination = {};
      resume() { return Promise.resolve(); }
      createBuffer() { return {}; }
      createBufferSource() {
        bufferSources++;
        return { buffer: null, connect() {}, start() {} };
      }
    },
    get speechSynthesis() { speechCalls++; return { speak() {}, cancel() {} }; },
  };
  (globalThis as any).Audio = class { muted = false; play() { return Promise.resolve(); } pause() {} };
  (globalThis as any).SpeechSynthesisUtterance = class { volume = 1; constructor(public text: string) {} };

  const { unlockAudio } = await import('../src/lib/audioUnlock.ts');
  for (let i = 0; i < 25; i++) unlockAudio();

  assert.equal(bufferSources, 1, `priming ran ${bufferSources} times across 25 taps; it is a one-time gate`);
  assert.equal(speechCalls, 0, 'this module must not touch speechSynthesis — it is VoiceOver’s engine on iOS');
});
