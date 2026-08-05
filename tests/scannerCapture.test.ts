// End-to-end cover for the MenuScanner STATE MACHINE (not just its pure
// metrics): does auto-capture actually fire, in both phone orientations, and
// does the "turn the phone" advice stay advisory instead of blocking a shot?
//
// The pure-function tests next door verify the measurements. This file verifies
// the loop that acts on them, which is where a wide menu in a portrait frame
// could silently stall — the case a blind tester reported from a restaurant.
//
// Only the two DOM calls the scanner makes are stubbed (canvas + video
// dimensions); the scanner's own logic runs unmodified. Ticks are driven
// manually so the test is deterministic and does not wait on real timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BACKGROUND = 180;

interface Scene { menuAspect: number; fillFrac: number }
let scene: Scene = { menuAspect: 1.294, fillFrac: 0.92 };
let lastBuffer = { w: 0, h: 0 };

/** Render the current scene at whatever buffer size the scanner asks for. */
function renderScene(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  let mw = w * scene.fillFrac;
  let mh = mw / scene.menuAspect;
  if (mh > h * scene.fillFrac) { mh = h * scene.fillFrac; mw = mh * scene.menuAspect; }
  const x0 = Math.round((w - mw) / 2), x1 = Math.round(x0 + mw) - 1;
  const y0 = Math.round((h - mh) / 2), y1 = Math.round(y0 + mh) - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
      const v = inside ? (Math.floor(y / 6) % 2 === 0 ? 40 : 220) : BACKGROUND;
      const p = (y * w + x) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

const fakeCtx = {
  drawImage() {},
  getImageData(_x: number, _y: number, w: number, h: number) {
    lastBuffer = { w, h };
    return { data: renderScene(w, h), width: w, height: h };
  },
};
(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx }),
};

const { MenuScanner } = await import('../src/lib/scanner.ts');

interface RunResult { captures: number; coach: string[]; buffer: { w: number; h: number } }

/** Run N scanner ticks against a fixed scene and collect what it did. */
function run(videoWidth: number, videoHeight: number, ticks = 12): RunResult {
  const coach: string[] = [];
  let captures = 0;
  const scanner: any = new MenuScanner();
  const video = { videoWidth, videoHeight } as any;
  scanner.start(video, {
    onCoach: (m: string) => coach.push(m),
    onCapture: () => { captures++; scanner.acknowledgeCapture(); },
  });
  // Drive the loop directly; start()'s interval never gets a chance to fire.
  for (let i = 0; i < ticks; i++) scanner.tick();
  scanner.stop();
  return { captures, coach, buffer: lastBuffer };
}

const isRotationAdvice = (msg: string) =>
  msg.includes('Turning the phone sideways') || msg.includes('Holding the phone upright');

test('the analysis buffer follows the phone: tall for portrait, wide for landscape', () => {
  const portrait = run(1080, 1920, 2);
  assert.ok(portrait.buffer.h > portrait.buffer.w, `portrait buffer was ${portrait.buffer.w}x${portrait.buffer.h}`);
  const landscape = run(1920, 1080, 2);
  assert.ok(landscape.buffer.w > landscape.buffer.h, `landscape buffer was ${landscape.buffer.w}x${landscape.buffer.h}`);
});

test('a wide menu held with the phone upright still auto-captures — advice never blocks the shot', () => {
  scene = { menuAspect: 1.294, fillFrac: 0.92 };
  const r = run(1080, 1920);
  assert.ok(r.captures > 0, `auto-capture never fired. Coaching was: ${r.coach.join(' | ')}`);
  assert.ok(
    r.coach.some(isRotationAdvice),
    `expected advice to turn the phone; got: ${r.coach.join(' | ')}`
  );
});

test('a wide menu with the phone already sideways auto-captures and says nothing about rotating', () => {
  scene = { menuAspect: 1.294, fillFrac: 0.92 };
  const r = run(1920, 1080);
  assert.ok(r.captures > 0, `auto-capture never fired. Coaching was: ${r.coach.join(' | ')}`);
  assert.ok(
    !r.coach.some(isRotationAdvice),
    `the phone is already the right way round; got: ${r.coach.join(' | ')}`
  );
});

test('an ordinary upright menu with the phone upright auto-captures with no rotation advice', () => {
  scene = { menuAspect: 0.773, fillFrac: 0.92 };
  const r = run(1080, 1920);
  assert.ok(r.captures > 0, `auto-capture never fired. Coaching was: ${r.coach.join(' | ')}`);
  assert.ok(!r.coach.some(isRotationAdvice), `got: ${r.coach.join(' | ')}`);
});

test('a tall menu framed by a sideways phone auto-captures and advises standing it upright', () => {
  scene = { menuAspect: 0.773, fillFrac: 0.92 };
  const r = run(1920, 1080);
  assert.ok(r.captures > 0, `auto-capture never fired. Coaching was: ${r.coach.join(' | ')}`);
  assert.ok(
    r.coach.some((m) => m.includes('Holding the phone upright')),
    `expected advice to stand the phone up; got: ${r.coach.join(' | ')}`
  );
});

test('rotation advice never interrupts the capture countdown', () => {
  scene = { menuAspect: 1.294, fillFrac: 0.92 };
  const r = run(1080, 1920);
  // Once "Hold still. Three." starts, nothing may speak over the countdown.
  const start = r.coach.findIndex((m) => m.includes('Three.'));
  assert.ok(start >= 0, `countdown never started: ${r.coach.join(' | ')}`);
  const during = r.coach.slice(start).filter(isRotationAdvice);
  assert.equal(during.length, 0, `rotation advice spoke over the countdown: ${r.coach.slice(start).join(' | ')}`);
});

test('rotation advice is not repeated on every frame', () => {
  scene = { menuAspect: 1.294, fillFrac: 0.92 };
  const r = run(1080, 1920, 40);
  const hints = r.coach.filter(isRotationAdvice).length;
  assert.ok(hints <= 2, `advice repeated ${hints} times across 40 frames — that reads as nagging`);
});
