// Guided menu scanner — auto-shutter with real image analysis and actionable
// audio coaching for blind users. Replaces the old autocapture.ts.
//
// Per-frame metrics (160x120 grayscale, ~6fps, main thread — cheap at this size):
//   - luminance      mean brightness (too dark?)
//   - glareFrac      fraction of blown-out pixels (glare/reflection — a mean
//                    brightness check misses glare on an otherwise dim photo)
//   - sharpness      Laplacian variance (blur — from the earlier scanner prototype)
//   - edgeDensity    how much text-like detail is in frame (is a menu there?)
//   - centroid       where the detail is (directional "move the menu left" hints)
//   - motion         inter-frame difference (steadiness)
//
// Coaching strategy:
//   - Each problem state has 2 escalating messages with a concrete fix; after
//     the second, silence until the state changes (no nagging).
//   - Steadying: spoken 3-2-1 countdown + rising earcon ticks, then capture.
//   - BEST-SHOT FALLBACK: if lighting + content are fine but perfect steadiness
//     never arrives, capture anyway after ~5s. The vision model tolerates a
//     slightly soft photo far better than a frustrated user tolerates waiting.
//   - After 20s without any capture, onStruggle fires -> manual mode.
//   - Every state change is reported via onState for telemetry.

export type ScanState =
  | 'searching'   // no menu-like content in frame
  | 'dark'
  | 'glare'
  | 'blur'
  | 'offcenter'
  | 'tooClose'    // content bleeds past the visible frame on opposite sides
  | 'tooFar'      // content occupies only a small part of the frame
  | 'skewed'      // page is tilted/rotated relative to the camera
  | 'moving'
  | 'steadying'
  | 'disarmed'    // captured; waiting for movement to re-arm for the next page
  | 'rotateDevice'; // advisory only: reported to telemetry, never entered as a state

export interface ScannerCallbacks {
  onCoach: (msg: string) => void;
  onCapture: () => void;
  onStruggle?: () => void;
  onState?: (state: ScanState, detail?: string) => void;
  onProgress?: (state: ScanState, steadyCount: number, steadyMax: number) => void;
  /** Return true when the camera accepted an automatic zoom step. */
  onAutoZoom?: (direction: 1 | -1) => boolean;
}

// Per-frame analysis runs on a downsampled buffer. The buffer must keep the
// CAMERA's aspect ratio: squashing a 9:16 portrait frame into a fixed 4:3
// buffer stretches x relative to y by ~2.4x, which silently corrupts every
// geometric metric. Measured effect of the old fixed 160x120 buffer:
//   portrait phone : a real 20deg tilt read as 11deg -> no warning at all
//   landscape phone: a real  8deg tilt read as 13deg -> false "menu is tilted"
// So the app under-warned in the orientation people actually hold a phone, and
// nagged in the other. analysisSize() keeps the pixel BUDGET at ~160x120 (so
// the luminance/glare/edge/sharpness thresholds below stay valid, since those
// depend on pixel count rather than shape) while matching the frame's shape.
const ANALYSIS_PIXELS = 160 * 120;
const TICK_MS = 170;

/** Analysis buffer dimensions for a video frame: same aspect, ~constant area. */
export function analysisSize(videoWidth: number, videoHeight: number): { w: number; h: number } {
  if (!videoWidth || !videoHeight) return { w: 160, h: 120 };
  const aspect = videoWidth / videoHeight;
  const w = Math.max(16, Math.round(Math.sqrt(ANALYSIS_PIXELS * aspect)));
  const h = Math.max(16, Math.round(w / aspect));
  return { w, h };
}

// Thresholds (tuned for indoor restaurant light; metrics computed over an
// ~19200-pixel buffer, whatever shape the camera frame is — see analysisSize).
// Exported so lib/photoQuality.ts can judge a STILL photo by the identical
// dark/blur/glare/framing/skew bar used to coach the live camera — one
// source of truth for "is this readable" across both live and post-capture.
export const LUM_DARK = 40;          // mean luminance below this = too dark
export const GLARE_FRAC = 0.10;      // >10% blown-out pixels = glare
const GLARE_PIXEL = 248;      // a pixel >= this counts as blown out
export const EDGE_MIN = 0.035;       // edge density below this = no menu text in frame
export const SHARP_MIN = 60;         // Laplacian variance below this = blurry
const MOTION_STEADY = 7;      // mean abs diff below this = holding steady
const REARM_MOTION = 14;      // movement above this re-arms after a capture
const STEADY_TICKS = 4;       // ~0.7s of steady before the shutter
const OFFCENTER = 0.22;       // centroid offset (0..0.5) before directional hint

// Framing (distance + rotation) thresholds — see computeFrameMetrics().
// Border tolerance is a FRACTION of each axis, not an absolute pixel count, so
// "content reaches the edge" means the same thing on a tall buffer as a wide
// one. 2% reproduces the old 3px on a 160-wide buffer.
const BORDER_MARGIN_FRAC = 0.02;
export const TOO_FAR_BBOX = 0.42;    // content bounding box narrower than this fraction (both dims) = too far
// Skew now measures the TRUE page angle (see analysisSize). Before the aspect
// fix the reading was distorted, so 12 here really meant "warn at ~28deg in
// portrait, ~8deg in landscape". Against a faithful measurement 18 warns at a
// real tilt of roughly 15deg — past the point where a page looks crooked, but
// forgiving of the few degrees nobody can hold a phone within, and well inside
// what the vision model reads without trouble.
export const SKEW_WARN_DEG = 18;
// Orientation mismatch: the menu's long edge runs across the frame's SHORT
// edge, so turning the phone would gain real estate. Ratios are generous —
// letter landscape is 1.29, so 1.25 catches it while ignoring square-ish pages.
const ROTATE_CONTENT_RATIO = 1.25;
// ...but only worth saying when the page is actually letterboxed. If content
// already fills the frame both ways, rotating gains nothing.
const ROTATE_SLACK_FRAC = 0.72;

const ESCALATE_MS = 5500;     // second-stage message after this long in a state
const BEST_SHOT_MS = 5000;    // content+light OK this long -> capture anyway
const STRUGGLE_MS = 20000;    // no capture at all -> hand over to manual
const HEARTBEAT_MS = 6000;    // reassure during long silence
const AUTO_ZOOM_MS = 700;     // require persistent bad framing between zoom steps

const COUNTDOWN: Record<number, string> = {
  1: 'Hold still. Three.',
  2: 'Two.',
  3: 'One.',
};

// [first message, escalation with a concrete fix]
const STAGE_MSGS: Record<string, [string, string]> = {
  searching: [
    'Point the camera at the menu. Hold the phone flat, about a foot above it.',
    "I don't see menu text yet. Slide the phone slowly over the table until I find it, or tap Take photo to capture now.",
  ],
  dark: [
    "It's too dark to read. Move toward a window or a lamp.",
    'Still dark. Tilt the menu toward the nearest light, or ask for a phone flashlight. You can also tap Take photo and I will try anyway.',
  ],
  glare: [
    'There is a shiny glare on the menu. Tilt the phone slightly to one side.',
    'Still seeing glare. Move the menu away from the light above it, or stand so your shadow covers the shiny spot.',
  ],
  blur: [
    'The picture is blurry. Lift the phone a little higher, about a foot above the menu.',
    'Still blurry. Rest your elbows on the table to keep the phone steady, and hold it a bit further from the page.',
  ],
  tooClose: [
    "You're very close to the menu. Move the phone back a bit so the whole page fits in the frame.",
    "Still too close. The menu doesn't fully fit. Hold the phone about a foot above the page.",
  ],
  tooFar: [
    'The menu looks small in the frame. Move the phone a little closer.',
    'Still far away. Bring the phone closer until the menu fills most of the frame.',
  ],
  skewed: [
    'The menu looks tilted. Hold the phone flat and level with the page.',
    'Still tilted, almost sideways. Line up the top edge of the phone with the top edge of the menu.',
  ],
  moving: [
    'I can see the menu. Now hold still.',
    'Almost there. Rest your elbows on the table, take a breath, and hold the phone still. Or tap Take photo whenever you are ready.',
  ],
};

// Rotation advice. Phrased so it is followable without seeing the screen: name
// the direction to turn, say what it achieves, and make clear it is optional —
// auto capture keeps working either way, so nobody is stuck waiting on it.
const ROTATE_MSGS: Record<'toLandscape' | 'toPortrait', string> = {
  toLandscape:
    'This menu is wider than it is tall. Turning the phone sideways, so its long edge runs left to right, will fit more of it. You can also keep going as you are.',
  toPortrait:
    'This menu is taller than it is wide. Holding the phone upright will fit more of it. You can also keep going as you are.',
};
const ROTATE_HINT_MS = 12000; // don't repeat the same rotation advice sooner

export interface FrameMetrics {
  luminance: number;
  glareFrac: number;
  sharpness: number;
  edgeDensity: number;
  cx: number; // 0..1 centroid of edge energy
  cy: number;
  motion: number;
  // Framing: is the whole page in frame, and is it held level?
  bboxWidthFrac: number;  // 0..1, width of the detected content's bounding box
  bboxHeightFrac: number; // 0..1
  touchesBorder: boolean; // content bbox reaches opposite frame edges — page is cropped, too close
  skewDeg: number;        // 0..45, mean edge-angle distance from the nearest axis (0 = level)
  // Orientation. Both are true geometry as long as the buffer keeps the
  // camera's aspect ratio (analysisSize) — that is what makes them comparable.
  frameAspect: number;    // buffer w/h: >1 camera is landscape, <1 portrait
  contentAspect: number;  // detected page w/h: >1 the menu is wider than tall; 0 when no content
}

/**
 * Pure per-frame image analysis — no DOM/canvas, so it's directly unit
 * testable with synthetic grayscale buffers. `gray` is row-major, length w*h.
 * `prevGray` (previous frame, same size) is used for the motion/steadiness
 * signal; pass null on the first frame.
 */
export function computeFrameMetrics(gray: Float32Array, w: number, h: number, prevGray: Float32Array | null): FrameMetrics {
  let lumSum = 0;
  let glare = 0;
  for (let p = 0; p < gray.length; p++) {
    lumSum += gray[p];
    if (gray[p] >= GLARE_PIXEL) glare++;
  }
  const n = w * h;
  const luminance = lumSum / n;
  const glareFrac = glare / n;

  // Laplacian variance (blur) + edge density/centroid/bbox/orientation in one pass.
  let lapSum = 0, lapSq = 0;
  let edgeCount = 0, exSum = 0, eySum = 0, eTotal = 0;
  let bboxMinX = Infinity, bboxMaxX = -Infinity, bboxMinY = Infinity, bboxMaxY = -Infinity;
  let skewSum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      lapSum += lap;
      lapSq += lap * lap;
      const e = Math.abs(gray[i] - gray[i - 1]) + Math.abs(gray[i] - gray[i - w]);
      if (e > 24) {
        edgeCount++;
        exSum += e * x;
        eySum += e * y;
        eTotal += e;
        if (x < bboxMinX) bboxMinX = x;
        if (x > bboxMaxX) bboxMaxX = x;
        if (y < bboxMinY) bboxMinY = y;
        if (y > bboxMaxY) bboxMaxY = y;

        // Local gradient direction (central difference). A page held level
        // produces edges clustered near 0deg (horizontal, e.g. text-line
        // bands) or 90deg (vertical, e.g. letter strokes/page edges); a
        // tilted page shifts that cluster away from both axes by roughly the
        // tilt angle, which is what skewDeg measures.
        const gx = gray[i + 1] - gray[i - 1];
        const gy = gray[i + w] - gray[i - w];
        const theta = Math.atan2(gy, gx) * (180 / Math.PI); // -180..180
        let folded = theta;
        if (folded > 90) folded -= 180;
        else if (folded <= -90) folded += 180;
        const absTheta = Math.abs(folded); // 0..90
        const distToAxis = Math.min(absTheta, 90 - absTheta); // 0 (aligned) .. 45 (diagonal)
        skewSum += distToAxis * e;
      }
    }
  }
  const inner = (w - 2) * (h - 2);
  const lapMean = lapSum / inner;
  const sharpness = lapSq / inner - lapMean * lapMean;
  const edgeDensity = edgeCount / inner;
  const cx = eTotal > 0 ? exSum / eTotal / w : 0.5;
  const cy = eTotal > 0 ? eySum / eTotal / h : 0.5;

  const hasContent = eTotal > 0;
  const bboxWidthFrac = hasContent ? (bboxMaxX - bboxMinX + 1) / w : 0;
  const bboxHeightFrac = hasContent ? (bboxMaxY - bboxMinY + 1) / h : 0;
  const marginX = Math.max(1, Math.round(w * BORDER_MARGIN_FRAC));
  const marginY = Math.max(1, Math.round(h * BORDER_MARGIN_FRAC));
  const touchesLeft = hasContent && bboxMinX <= 1 + marginX;
  const touchesRight = hasContent && bboxMaxX >= w - 2 - marginX;
  const touchesTop = hasContent && bboxMinY <= 1 + marginY;
  const touchesBottom = hasContent && bboxMaxY >= h - 2 - marginY;
  const touchesBorder = (touchesLeft && touchesRight) || (touchesTop && touchesBottom);
  const skewDeg = hasContent ? skewSum / eTotal : 0;

  // Content aspect in real pixels, not frame fractions: a bbox covering 100% of
  // a 104-wide buffer and 44% of a 185-tall one is a WIDE page (104 x 81), even
  // though the fractions alone would suggest the opposite.
  const frameAspect = w / h;
  const contentAspect = hasContent && bboxHeightFrac > 0
    ? (bboxWidthFrac * w) / (bboxHeightFrac * h)
    : 0;

  let motion = Infinity;
  if (prevGray) {
    let m = 0;
    for (let i = 0; i < gray.length; i++) m += Math.abs(gray[i] - prevGray[i]);
    motion = m / gray.length;
  }

  return {
    luminance, glareFrac, sharpness, edgeDensity, cx, cy, motion,
    bboxWidthFrac, bboxHeightFrac, touchesBorder, skewDeg,
    frameAspect, contentAspect,
  };
}

/**
 * Would turning the phone 90 degrees fit more of this menu in frame?
 *
 * True only when the page's long edge runs across the frame's short edge AND
 * the page is letterboxed enough that rotating actually gains room. Pure, so
 * the exact trigger conditions are unit-testable.
 */
export function shouldSuggestRotation(m: FrameMetrics): 'toLandscape' | 'toPortrait' | null {
  if (m.contentAspect <= 0 || m.edgeDensity < EDGE_MIN) return null;
  const framePortrait = m.frameAspect < 1;
  if (framePortrait && m.contentAspect > ROTATE_CONTENT_RATIO && m.bboxHeightFrac < ROTATE_SLACK_FRAC) {
    return 'toLandscape';
  }
  if (!framePortrait && m.contentAspect < 1 / ROTATE_CONTENT_RATIO && m.bboxWidthFrac < ROTATE_SLACK_FRAC) {
    return 'toPortrait';
  }
  return null;
}

export class MenuScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D | null;
  private prev: Float32Array | null = null;
  private video: HTMLVideoElement | null = null;
  private cb: ScannerCallbacks | null = null;

  private armed = true;
  private armedAt = 0;
  private struggled = false;
  private steady = 0;
  private goodSince = 0;     // when lighting+content first became continuously OK
  private state: ScanState = 'searching';
  private coachStage = 0;
  private stateAt = 0;
  private lastCoachAt = 0;
  private lastAutoZoomAt = 0;
  private analysisZoom = 1;
  private announcedAutoZoom: 1 | -1 | 0 = 0;
  private rotateHintAt = 0;              // last time we suggested turning the phone
  private rotateHintDirection: 'toLandscape' | 'toPortrait' | null = null;

  constructor() {
    this.canvas.width = 160;
    this.canvas.height = 120;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  start(video: HTMLVideoElement, cb: ScannerCallbacks) {
    this.stop();
    this.video = video;
    this.cb = cb;
    this.armed = true;
    this.struggled = false;
    this.steady = 0;
    this.goodSince = 0;
    this.prev = null;
    this.state = 'searching';
    this.coachStage = -1; // force first message
    this.stateAt = Date.now();
    this.lastCoachAt = Date.now();
    this.armedAt = Date.now();
    this.lastAutoZoomAt = 0;
    this.announcedAutoZoom = 0;
    this.rotateHintAt = 0;
    this.rotateHintDirection = null;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Match scanner analysis to the centered crop used by software zoom. */
  setAnalysisZoom(value: number) {
    this.analysisZoom = Math.max(1, value);
    this.prev = null;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Release the detached <video>/stream and React closures (REVIEW.md #11).
    this.video = null;
    this.cb = null;
    this.prev = null;
  }

  /** Call after a capture so the scanner waits for movement before re-arming. */
  acknowledgeCapture() {
    this.armed = false;
    this.steady = 0;
    this.goodSince = 0;
    this.setState('disarmed');
  }

  private emit(msg: string) {
    this.lastCoachAt = Date.now();
    this.cb?.onCoach(msg);
  }

  private setState(next: ScanState, detail?: string) {
    if (next === this.state) return false;
    this.state = next;
    this.stateAt = Date.now();
    this.coachStage = -1;
    this.cb?.onState?.(next, detail);
    return true;
  }

  /** Speak stage-0 on entering a state, stage-1 after ESCALATE_MS, then silence. */
  private coachFor(state: ScanState, extra?: string) {
    const msgs = STAGE_MSGS[state];
    if (!msgs) return;
    const now = Date.now();
    if (this.coachStage < 0) {
      this.coachStage = 0;
      this.emit(extra ? `${msgs[0]} ${extra}` : msgs[0]);
    } else if (this.coachStage === 0 && now - this.stateAt > ESCALATE_MS) {
      this.coachStage = 1;
      this.emit(msgs[1]);
    } else if (this.coachStage === 1 && now - this.lastCoachAt > HEARTBEAT_MS * 3) {
      // After both staged messages, only a rare, state-neutral nudge — not an
      // every-6s nag in states where the canned text would be wrong (#10).
      this.emit('Still looking. Keep the menu under the camera.');
    }
  }

  private analyze(): FrameMetrics | null {
    const v = this.video;
    if (!v || !this.ctx || v.videoWidth === 0) return null;

    // Keep the analysis buffer shaped like the camera frame. When the phone is
    // turned the track's dimensions swap, so re-shape and drop everything that
    // was measured against the old geometry: the previous frame (otherwise the
    // rotation itself reads as violent motion), the steadiness streak, and the
    // best-shot clock. The rotation hint re-arms too — the advice that was true
    // a moment ago may be exactly backwards now.
    const { w, h } = analysisSize(v.videoWidth, v.videoHeight);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.prev = null;
      this.steady = 0;
      this.goodSince = 0;
      this.rotateHintAt = 0;
      this.rotateHintDirection = null;
      // Turning the phone is progress, usually because we just asked for it —
      // so restart the give-up clock rather than punishing the user for the
      // seconds they spent framing the other way round.
      this.armedAt = Date.now();
    }

    if (this.analysisZoom === 1) {
      this.ctx.drawImage(v, 0, 0, w, h);
    } else {
      const sourceWidth = v.videoWidth / this.analysisZoom;
      const sourceHeight = v.videoHeight / this.analysisZoom;
      const sourceX = (v.videoWidth - sourceWidth) / 2;
      const sourceY = (v.videoHeight - sourceHeight) / 2;
      this.ctx.drawImage(v, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, w, h);
    }
    const rgba = this.ctx.getImageData(0, 0, w, h).data;

    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
      gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }

    // prev is only a valid motion reference when it came from the same geometry.
    const prev = this.prev && this.prev.length === gray.length ? this.prev : null;
    const metrics = computeFrameMetrics(gray, w, h, prev);
    this.prev = gray;
    return metrics;
  }

  /**
   * Advisory "turn the phone" nudge. Deliberately NOT a ScanState: it never
   * blocks or delays a capture, it just adds a sentence when one would help.
   * Silent during the countdown so it can't talk over "Three. Two. One.", and
   * rate-limited so it reads as advice rather than nagging.
   */
  private maybeSuggestRotation(m: FrameMetrics) {
    if (this.steady > 0) return; // mid-countdown — a capture is imminent
    const direction = shouldSuggestRotation(m);
    if (!direction) {
      this.rotateHintDirection = null;
      return;
    }
    const now = Date.now();
    const changed = direction !== this.rotateHintDirection;
    if (!changed && now - this.rotateHintAt < ROTATE_HINT_MS) return;
    this.rotateHintAt = now;
    this.rotateHintDirection = direction;
    this.cb?.onState?.('rotateDevice', direction);
    this.emit(ROTATE_MSGS[direction]);
  }

  private fireCapture(reason: 'steady' | 'best_shot') {
    this.steady = 0;
    this.goodSince = 0;
    this.cb?.onState?.('steadying', `capture_${reason}`);
    this.emit(reason === 'steady' ? 'Capturing now.' : 'Good enough. Taking the photo now.');
    this.cb?.onProgress?.('steadying', STEADY_TICKS, STEADY_TICKS);
    this.cb?.onCapture();
  }

  private tryAutoZoom(direction: 1 | -1): 'adjusted' | 'waiting' | 'unavailable' {
    const now = Date.now();
    if (now - this.stateAt < AUTO_ZOOM_MS || now - this.lastAutoZoomAt < AUTO_ZOOM_MS) return 'waiting';
    if (!this.cb?.onAutoZoom?.(direction)) return 'unavailable';
    this.lastAutoZoomAt = now;
    this.prev = null;
    if (this.announcedAutoZoom !== direction) {
      this.announcedAutoZoom = direction;
      this.emit(direction > 0
        ? 'The menu looks small. Adjusting zoom in.'
        : 'The menu is too close. Adjusting zoom out.');
    }
    return 'adjusted';
  }

  private tick() {
    const m = this.analyze();
    if (!m || !this.cb) return;

    if (!this.armed) {
      this.cb.onProgress?.('disarmed', 0, STEADY_TICKS);
      if (m.motion > REARM_MOTION) {
        this.armed = true;
        this.armedAt = Date.now();
        this.struggled = false;
        this.setState('searching');
        this.coachStage = 0; // skip the long intro on re-arm
        this.emit('Ready for the next page.');
      }
      return;
    }

    // Only fall back to manual if the user is making NO progress. If they just
    // got steady (goodSince set, or steady ticks accumulating), a capture is
    // imminent — don't yank auto mode away right before it fires (REVIEW.md #9).
    if (
      !this.struggled &&
      this.steady === 0 &&
      !this.goodSince &&
      Date.now() - this.armedAt > STRUGGLE_MS
    ) {
      this.struggled = true;
      this.cb.onStruggle?.();
      return;
    }

    // Priority: dark -> glare -> content present -> blur -> steady.
    if (m.luminance < LUM_DARK) {
      this.steady = 0;
      this.goodSince = 0;
      this.setState('dark', `lum=${m.luminance.toFixed(0)}`);
      this.coachFor('dark');
      this.cb.onProgress?.('dark', 0, STEADY_TICKS);
      return;
    }

    if (m.glareFrac > GLARE_FRAC) {
      this.steady = 0;
      this.goodSince = 0;
      this.setState('glare', `glare=${(m.glareFrac * 100).toFixed(0)}%`);
      this.coachFor('glare');
      this.cb.onProgress?.('glare', 0, STEADY_TICKS);
      return;
    }

    if (m.edgeDensity < EDGE_MIN) {
      this.steady = 0;
      this.goodSince = 0;
      // Directional hint: where is the little detail we DO see?
      let dir: string | undefined;
      const dx = m.cx - 0.5;
      const dy = m.cy - 0.5;
      if (m.edgeDensity > EDGE_MIN * 0.3 && (Math.abs(dx) > OFFCENTER || Math.abs(dy) > OFFCENTER)) {
        if (Math.abs(dx) >= Math.abs(dy)) {
          dir = dx > 0 ? 'I see something on the right. Move the phone slightly right.' : 'I see something on the left. Move the phone slightly left.';
        } else {
          dir = dy > 0 ? 'I see something near the bottom. Pull the phone toward you a little.' : 'I see something near the top. Push the phone away from you a little.';
        }
      }
      this.setState('searching', `edges=${(m.edgeDensity * 100).toFixed(1)}%`);
      this.coachFor('searching', dir);
      this.cb.onProgress?.('searching', 0, STEADY_TICKS);
      return;
    }

    // Content is in frame. Before the framing checks below can start pushing
    // zoom around, say whether turning the phone would simply fit the page —
    // this is the one situation where zoom alone cannot win, because a wide
    // menu in a portrait frame is cropped at one zoom and tiny at the next.
    // Advisory: never returns, never delays a capture.
    this.maybeSuggestRotation(m);

    // Framing: is the whole page in frame, and is it held level? These block
    // capture the same way dark/glare/searching do — a crooked or badly
    // cropped photo is far more likely to fail menu extraction than a
    // slightly soft one, so there is no best-shot bypass for these states.
    if (m.touchesBorder) {
      this.steady = 0;
      this.goodSince = 0;
      this.setState('tooClose', `bbox=${(m.bboxWidthFrac * 100).toFixed(0)}x${(m.bboxHeightFrac * 100).toFixed(0)}%`);
      const zoomResult = this.tryAutoZoom(-1);
      if (zoomResult === 'unavailable') {
        this.coachFor('tooClose');
      }
      this.cb.onProgress?.('tooClose', 0, STEADY_TICKS);
      return;
    }

    if (m.bboxWidthFrac < TOO_FAR_BBOX && m.bboxHeightFrac < TOO_FAR_BBOX) {
      this.steady = 0;
      this.goodSince = 0;
      this.setState('tooFar', `bbox=${(m.bboxWidthFrac * 100).toFixed(0)}x${(m.bboxHeightFrac * 100).toFixed(0)}%`);
      const zoomResult = this.tryAutoZoom(1);
      if (zoomResult === 'unavailable') {
        this.coachFor('tooFar');
      }
      this.cb.onProgress?.('tooFar', 0, STEADY_TICKS);
      return;
    }

    if (m.skewDeg > SKEW_WARN_DEG) {
      this.steady = 0;
      this.goodSince = 0;
      this.setState('skewed', `skew=${m.skewDeg.toFixed(0)}deg`);
      this.coachFor('skewed');
      this.cb.onProgress?.('skewed', 0, STEADY_TICKS);
      return;
    }

    this.announcedAutoZoom = 0;
    // From here on lighting + content are OK — start the best-shot clock.
    if (!this.goodSince) this.goodSince = Date.now();
    const bestShotDue = Date.now() - this.goodSince > BEST_SHOT_MS;

    if (m.motion !== Infinity && m.motion <= MOTION_STEADY && m.sharpness < SHARP_MIN) {
      // Blurry while steady = focus/height problem, not hand shake.
      this.steady = 0;
      if (bestShotDue) { this.fireCapture('best_shot'); return; }
      this.setState('blur', `sharp=${m.sharpness.toFixed(0)}`);
      this.coachFor('blur');
      this.cb.onProgress?.('blur', 0, STEADY_TICKS);
      return;
    }

    if (m.motion === Infinity || m.motion > MOTION_STEADY) {
      this.steady = 0;
      if (bestShotDue && m.motion < REARM_MOTION) { this.fireCapture('best_shot'); return; }
      this.setState('moving', `motion=${m.motion === Infinity ? 'inf' : m.motion.toFixed(1)}`);
      this.coachFor('moving');
      this.cb.onProgress?.('moving', 0, STEADY_TICKS);
      return;
    }

    // Steady and sharp: countdown to capture.
    this.setState('steadying');
    this.steady++;
    if (this.steady >= STEADY_TICKS) {
      this.fireCapture('steady');
    } else {
      const msg = COUNTDOWN[this.steady];
      if (msg) this.emit(msg);
      this.cb.onProgress?.('steadying', this.steady, STEADY_TICKS);
    }
  }
}
