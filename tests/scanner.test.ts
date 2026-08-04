// Scanner framing detection (pure function). Synthesizes grayscale frames
// with a "page" region containing high-contrast stripes at a known angle, so
// bounding-box and skew measurements can be checked against known values
// without needing a real camera/canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFrameMetrics,
  analysisSize,
  shouldSuggestRotation,
  SKEW_WARN_DEG,
} from '../src/lib/scanner.ts';
import type { FrameMetrics } from '../src/lib/scanner.ts';

const W = 160;
const H = 120;
const BACKGROUND = 180; // uniform, edge-free "table" outside the page region

interface Bbox { minX: number; maxX: number; minY: number; maxY: number }

/**
 * A grayscale frame with a uniform background and a rectangular "page"
 * region filled with alternating high-contrast stripes. `lineAngleDeg` is the
 * angle of the stripe BOUNDARY lines from horizontal (0 = horizontal lines,
 * like text baselines; 90 = vertical lines, like letter stems/page edges).
 */
function makeFrame(bbox: Bbox, lineAngleDeg: number, period = 6): Float32Array {
  const gray = new Float32Array(W * H).fill(BACKGROUND);
  const rad = (lineAngleDeg * Math.PI) / 180;
  const nx = -Math.sin(rad);
  const ny = Math.cos(rad);
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const d = x * nx + y * ny;
      gray[y * W + x] = Math.floor(d / period) % 2 === 0 ? 40 : 220;
    }
  }
  return gray;
}

const CENTERED: Bbox = { minX: 32, maxX: 128, minY: 24, maxY: 96 }; // ~60% of frame, centered
const FULL_FRAME: Bbox = { minX: 0, maxX: W - 1, minY: 0, maxY: H - 1 };
const SMALL_CENTERED: Bbox = { minX: 65, maxX: 95, minY: 50, maxY: 70 }; // ~19% x ~17%

test('a well-framed, level page reads as in-frame and not skewed', () => {
  const frame = makeFrame(CENTERED, 0);
  const m = computeFrameMetrics(frame, W, H, null);
  assert.ok(m.bboxWidthFrac > 0.5 && m.bboxWidthFrac < 0.8, `bboxWidthFrac=${m.bboxWidthFrac}`);
  assert.ok(m.bboxHeightFrac > 0.5 && m.bboxHeightFrac < 0.8, `bboxHeightFrac=${m.bboxHeightFrac}`);
  assert.equal(m.touchesBorder, false);
  assert.ok(m.skewDeg < 12, `skewDeg=${m.skewDeg} should be well under the 12deg warn threshold`);
});

test('content bleeding to opposite frame edges reads as too close', () => {
  const frame = makeFrame(FULL_FRAME, 0);
  const m = computeFrameMetrics(frame, W, H, null);
  assert.equal(m.touchesBorder, true, 'a page filling the whole frame should be flagged as touching the border');
});

test('a small, centered page reads as too far (small bounding box)', () => {
  const frame = makeFrame(SMALL_CENTERED, 0);
  const m = computeFrameMetrics(frame, W, H, null);
  assert.ok(m.bboxWidthFrac < 0.42, `bboxWidthFrac=${m.bboxWidthFrac} should be below the too-far threshold`);
  assert.ok(m.bboxHeightFrac < 0.42, `bboxHeightFrac=${m.bboxHeightFrac} should be below the too-far threshold`);
  assert.equal(m.touchesBorder, false, 'a small centered page should not also read as too close');
});

test('a page rotated ~20 degrees reads as skewed', () => {
  const level = computeFrameMetrics(makeFrame(CENTERED, 0), W, H, null);
  const tilted = computeFrameMetrics(makeFrame(CENTERED, 20), W, H, null);
  assert.ok(tilted.skewDeg > level.skewDeg, `tilted skew (${tilted.skewDeg}) should exceed level skew (${level.skewDeg})`);
  assert.ok(tilted.skewDeg > 12, `skewDeg=${tilted.skewDeg} should cross the 12deg warn threshold`);
  // The measured skew should roughly track the actual rotation, allowing for
  // discretization error at 160x120.
  assert.ok(Math.abs(tilted.skewDeg - 20) < 10, `skewDeg=${tilted.skewDeg} should be roughly close to the 20deg rotation applied`);
});

test('a page rotated a further amount reads as more skewed, up to the 45deg diagonal ceiling', () => {
  const m20 = computeFrameMetrics(makeFrame(CENTERED, 20), W, H, null);
  const m35 = computeFrameMetrics(makeFrame(CENTERED, 35), W, H, null);
  assert.ok(m35.skewDeg > m20.skewDeg, `35deg rotation (${m35.skewDeg}) should read as more skewed than 20deg (${m20.skewDeg})`);
});

test('KNOWN LIMITATION: an exact 90-degree rotation is indistinguishable from level', () => {
  // Local edge-gradient orientation cannot tell a page rotated 0deg from one
  // rotated 90deg — both are equally "axis aligned", just on different axes.
  // Detecting a true 90deg turn (phone held sideways) would need document
  // boundary/aspect-ratio detection, which this lightweight per-frame
  // heuristic does not do. This test documents that gap rather than hiding it.
  const level = computeFrameMetrics(makeFrame(CENTERED, 0), W, H, null);
  const rotated90 = computeFrameMetrics(makeFrame(CENTERED, 90), W, H, null);
  assert.ok(level.skewDeg < 12);
  assert.ok(rotated90.skewDeg < 12, `rotated90.skewDeg=${rotated90.skewDeg} — expected to also read as level (documents the blind spot)`);
});

test('a blank, edge-free frame reports no content rather than a false too-far/too-close reading', () => {
  const blank = new Float32Array(W * H).fill(BACKGROUND);
  const m = computeFrameMetrics(blank, W, H, null);
  assert.equal(m.bboxWidthFrac, 0);
  assert.equal(m.bboxHeightFrac, 0);
  assert.equal(m.touchesBorder, false);
  assert.equal(m.skewDeg, 0);
  // In the real scanner, edgeDensity below EDGE_MIN routes to the 'searching'
  // state before framing checks ever run, so a blank frame is never
  // misreported as "too far" — verified here at the metrics level.
  assert.ok(m.edgeDensity < 0.035, `edgeDensity=${m.edgeDensity} should be below EDGE_MIN so 'searching' takes priority`);
});

// ── Orientation: the analysis buffer must keep the camera's aspect ratio ────
// Regression cover for a geometry bug that made every angle/framing metric
// depend on which way the phone was held. The old scanner squashed each frame
// into a fixed 160x120 buffer, so on a 9:16 portrait phone x was stretched
// ~2.4x relative to y. Measured consequence: a real 20deg tilt read as 11deg
// (no warning), while on a 16:9 landscape phone a real 8deg tilt read as
// 13deg (a warning nobody needed).

/** Same striped-page frame as makeFrame, at an arbitrary buffer size. */
function makeFrameAt(
  w: number,
  h: number,
  bbox: Bbox,
  lineAngleDeg: number,
  period = 6
): Float32Array {
  const gray = new Float32Array(w * h).fill(BACKGROUND);
  const rad = (lineAngleDeg * Math.PI) / 180;
  const nx = -Math.sin(rad);
  const ny = Math.cos(rad);
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const d = x * nx + y * ny;
      gray[y * w + x] = Math.floor(d / period) % 2 === 0 ? 40 : 220;
    }
  }
  return gray;
}

// Buffers analysisSize() produces for the two ways a phone gets held.
const PORTRAIT = analysisSize(1080, 1920); // 9:16
const LANDSCAPE = analysisSize(1920, 1080); // 16:9

test('analysisSize keeps the camera aspect ratio and a near-constant pixel budget', () => {
  for (const [vw, vh] of [[1920, 1080], [1080, 1920], [640, 480], [480, 640], [1280, 720]]) {
    const { w, h } = analysisSize(vw, vh);
    const wantAspect = vw / vh;
    assert.ok(
      Math.abs(w / h - wantAspect) / wantAspect < 0.02,
      `${vw}x${vh} -> ${w}x${h}: aspect ${(w / h).toFixed(3)} should match ${wantAspect.toFixed(3)}`
    );
    // Thresholds are tuned against ~19200 analysed pixels; hold that steady.
    assert.ok(
      Math.abs(w * h - 160 * 120) / (160 * 120) < 0.05,
      `${vw}x${vh} -> ${w}x${h} = ${w * h}px, should stay near ${160 * 120}`
    );
  }
  // A 4:3 camera must still land exactly on the historical buffer.
  assert.deepEqual(analysisSize(640, 480), { w: 160, h: 120 });
});

test('the same physical tilt measures the same whether the phone is portrait or landscape', () => {
  // A 20deg-tilted page occupying the middle ~60% of each frame.
  const portrait = computeFrameMetrics(
    makeFrameAt(PORTRAIT.w, PORTRAIT.h, { minX: 20, maxX: 84, minY: 37, maxY: 148 }, 20),
    PORTRAIT.w, PORTRAIT.h, null
  );
  const landscape = computeFrameMetrics(
    makeFrameAt(LANDSCAPE.w, LANDSCAPE.h, { minX: 37, maxX: 148, minY: 20, maxY: 84 }, 20),
    LANDSCAPE.w, LANDSCAPE.h, null
  );
  assert.ok(
    Math.abs(portrait.skewDeg - landscape.skewDeg) < 4,
    `portrait read ${portrait.skewDeg.toFixed(1)}deg, landscape read ${landscape.skewDeg.toFixed(1)}deg — the same page must not depend on grip`
  );
  // ...and both must track the real 20deg, not a distorted version of it.
  assert.ok(Math.abs(portrait.skewDeg - 20) < 6, `portrait skewDeg=${portrait.skewDeg}`);
  assert.ok(Math.abs(landscape.skewDeg - 20) < 6, `landscape skewDeg=${landscape.skewDeg}`);
});

test('a clearly crooked page warns in portrait, where the old buffer stayed silent', () => {
  const m = computeFrameMetrics(
    makeFrameAt(PORTRAIT.w, PORTRAIT.h, { minX: 20, maxX: 84, minY: 37, maxY: 148 }, 25),
    PORTRAIT.w, PORTRAIT.h, null
  );
  assert.ok(m.skewDeg > SKEW_WARN_DEG, `skewDeg=${m.skewDeg.toFixed(1)} should cross the ${SKEW_WARN_DEG}deg warn threshold`);
});

test('a slightly-off page does not warn in landscape, where the old buffer cried wolf', () => {
  // 8deg is the tilt the old squashed buffer reported as ~13deg and warned on.
  const m = computeFrameMetrics(
    makeFrameAt(LANDSCAPE.w, LANDSCAPE.h, { minX: 37, maxX: 148, minY: 20, maxY: 84 }, 8),
    LANDSCAPE.w, LANDSCAPE.h, null
  );
  assert.ok(m.skewDeg < SKEW_WARN_DEG, `skewDeg=${m.skewDeg.toFixed(1)} should stay under the ${SKEW_WARN_DEG}deg threshold`);
});

test('"content reaches the frame edge" behaves the same on a tall buffer as a wide one', () => {
  const full = (w: number, h: number) =>
    computeFrameMetrics(makeFrameAt(w, h, { minX: 0, maxX: w - 1, minY: 0, maxY: h - 1 }, 0), w, h, null);
  assert.equal(full(PORTRAIT.w, PORTRAIT.h).touchesBorder, true);
  assert.equal(full(LANDSCAPE.w, LANDSCAPE.h).touchesBorder, true);
});

// ── Rotation advice ─────────────────────────────────────────────────────────
// Kayla's report: a wide (landscape) menu photographed with the phone upright.
// Zoom cannot solve that — zoom in and the page is cropped, zoom out and the
// text is too small. Turning the phone is the only fix, so the app has to say so.

test('a wide menu shot with the phone upright suggests turning it sideways', () => {
  // Letter-landscape menu (aspect ~1.29) fitted to the width of a portrait frame.
  const m = computeFrameMetrics(
    makeFrameAt(PORTRAIT.w, PORTRAIT.h, { minX: 4, maxX: 99, minY: 56, maxY: 129 }, 0),
    PORTRAIT.w, PORTRAIT.h, null
  );
  assert.ok(m.contentAspect > 1.25, `contentAspect=${m.contentAspect.toFixed(2)} should read as a wide page`);
  assert.equal(shouldSuggestRotation(m), 'toLandscape');
});

test('once the phone is turned, the same menu stops suggesting rotation', () => {
  // The same physical menu, now fitted to the height of a landscape frame.
  const m = computeFrameMetrics(
    makeFrameAt(LANDSCAPE.w, LANDSCAPE.h, { minX: 30, maxX: 154, minY: 4, maxY: 99 }, 0),
    LANDSCAPE.w, LANDSCAPE.h, null
  );
  assert.equal(shouldSuggestRotation(m), null, 'rotating already solved it — saying it again would be nagging');
});

test('an ordinary upright menu in an upright frame never suggests rotating', () => {
  // Letter-portrait menu (aspect ~0.77) fitted to the width of a portrait frame.
  const m = computeFrameMetrics(
    makeFrameAt(PORTRAIT.w, PORTRAIT.h, { minX: 4, maxX: 99, minY: 30, maxY: 153 }, 0),
    PORTRAIT.w, PORTRAIT.h, null
  );
  assert.equal(shouldSuggestRotation(m), null);
});

/** A FrameMetrics with healthy defaults, for probing one field at a time. */
function metrics(patch: Partial<FrameMetrics>): FrameMetrics {
  return {
    luminance: 120, glareFrac: 0, sharpness: 200, edgeDensity: 0.1,
    cx: 0.5, cy: 0.5, motion: 0,
    bboxWidthFrac: 0.6, bboxHeightFrac: 0.6, touchesBorder: false, skewDeg: 0,
    frameAspect: 0.5625, contentAspect: 1.0,
    ...patch,
  };
}

test('rotation is not suggested when the page already fills the frame — turning would gain nothing', () => {
  const roomToGain = metrics({ frameAspect: 0.5625, contentAspect: 1.4, bboxHeightFrac: 0.4 });
  assert.equal(shouldSuggestRotation(roomToGain), 'toLandscape');

  const alreadyFull = metrics({ frameAspect: 0.5625, contentAspect: 1.4, bboxHeightFrac: 0.9 });
  assert.equal(shouldSuggestRotation(alreadyFull), null);
});

test('rotation is not suggested when there is no menu in frame yet', () => {
  const empty = metrics({ contentAspect: 0, bboxWidthFrac: 0, bboxHeightFrac: 0 });
  assert.equal(shouldSuggestRotation(empty), null);

  const tooFewEdges = metrics({ edgeDensity: 0.001, contentAspect: 1.4, bboxHeightFrac: 0.4 });
  assert.equal(shouldSuggestRotation(tooFewEdges), null, 'noise should not be mistaken for a wide menu');
});

test('a tall menu framed by a sideways phone suggests standing it upright', () => {
  const m = metrics({ frameAspect: 1.778, contentAspect: 0.7, bboxWidthFrac: 0.4 });
  assert.equal(shouldSuggestRotation(m), 'toPortrait');
});

test('motion is Infinity on the first frame and a real number once a previous frame exists', () => {
  const frame1 = makeFrame(CENTERED, 0);
  const frame2 = makeFrame(CENTERED, 0);
  const first = computeFrameMetrics(frame1, W, H, null);
  const second = computeFrameMetrics(frame2, W, H, frame1);
  assert.equal(first.motion, Infinity);
  assert.ok(Number.isFinite(second.motion));
  assert.equal(second.motion, 0, 'identical consecutive frames should read as zero motion');
});
