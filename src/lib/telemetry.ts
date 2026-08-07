// Client-side telemetry. Batches events in memory, persists to localStorage
// for crash-safety, and flushes to /api/events on a timer and on page hide.
// Fire-and-forget: telemetry errors never surface to callers.

const SESSION_KEY = 'mv.tel.sid';
const QUEUE_KEY_PREFIX = 'mv.tel.queue';
const FLUSH_MS = 10_000;
const MAX_BATCH = 50;

export interface TelEvent {
  client_ts: string;
  user_email?: string;
  session_id: string;
  screen?: string;
  event_type: string;
  event_name: string;
  outcome?: 'success' | 'failure';
  duration_ms?: number;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  app_version: string;
  user_agent: string;
}

let _sid = '';
let _queue: TelEvent[] = [];
let _screen = 'home';
let _t0 = Date.now();

function sid(): string {
  if (_sid) return _sid;
  try {
    _sid = sessionStorage.getItem(SESSION_KEY) ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(SESSION_KEY, _sid);
  } catch {
    _sid = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return _sid;
}

// The signed-in address changes only at sign-in/out, but track() runs on every
// interaction — so re-reading and re-parsing the profile per event was pure
// main-thread cost on the tap path. Cache it, refreshing at most once every
// EMAIL_TTL_MS so a sign-in is still picked up promptly.
const EMAIL_TTL_MS = 5000;
let _emailCache: string | undefined;
let _emailAt = 0;

function email(): string | undefined {
  const now = Date.now();
  if (_emailAt && now - _emailAt < EMAIL_TTL_MS) return _emailCache;
  try {
    const raw = localStorage.getItem('menuvoice.profile.v1');
    _emailCache = raw ? (JSON.parse(raw)?.email as string) || undefined : undefined;
  } catch { _emailCache = undefined; }
  _emailAt = now;
  return _emailCache;
}

function queueKey() { return `${QUEUE_KEY_PREFIX}.${sid()}`; }

// localStorage.setItem is SYNCHRONOUS disk I/O. Writing the whole queue on
// every event meant each tap paid to re-serialise and re-write every event of
// the session so far (~19 KB by 50 events) before the UI could respond. The
// queue only exists so a crash doesn't lose events, and that is still true if
// the write trails the event slightly — so coalesce writes and force one at
// the moments that actually matter (flush, tab hide, page unload).
const PERSIST_DEBOUNCE_MS = 2000;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  try { localStorage.setItem(queueKey(), JSON.stringify(_queue)); } catch {}
}

function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => { _persistTimer = null; persistNow(); }, PERSIST_DEBOUNCE_MS);
}

function restore(): TelEvent[] {
  try { return JSON.parse(localStorage.getItem(queueKey()) ?? '[]') as TelEvent[]; } catch { return []; }
}

export function setCurrentScreen(screen: string) { _screen = screen; }

export function track(
  type: string,
  name: string,
  opts: {
    content?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    outcome?: 'success' | 'failure';
    durationMs?: number;
    screen?: string;
  } = {}
) {
  try {
    _queue.push({
      client_ts: new Date().toISOString(),
      user_email: email(),
      session_id: sid(),
      screen: opts.screen ?? _screen,
      event_type: type,
      event_name: name,
      outcome: opts.outcome,
      duration_ms: opts.durationMs,
      content: opts.content,
      metadata: opts.metadata,
      // Optional-chained: import.meta.env only exists under Vite. Without the
      // `?.` a missing define makes this throw on EVERY event, and track()'s
      // catch swallows it — silently killing all telemetry rather than losing
      // one field.
      app_version: String((import.meta.env as Record<string, unknown> | undefined)?.VITE_APP_VERSION ?? '1.0.0'),
      user_agent: navigator.userAgent,
    });
    // Deliberately NOT a synchronous write — see schedulePersist.
    schedulePersist();
  } catch {}
}

// keepalive fetch and sendBeacon reject bodies over 64 KiB; stay safely under.
const MAX_BODY_BYTES = 60_000;

async function flush(beacon = false) {
  if (!_queue.length) return;
  const batch = _queue.splice(0, MAX_BATCH);
  let body = JSON.stringify({ events: batch });
  // Shrink the batch until it fits; return the overflow to the queue.
  while (body.length > MAX_BODY_BYTES && batch.length > 1) {
    _queue.unshift(...batch.splice(Math.ceil(batch.length / 2)));
    body = JSON.stringify({ events: batch });
  }
  if (body.length > MAX_BODY_BYTES) {
    // Single poison event too large to ever send: drop it instead of wedging.
    persistNow();
    return;
  }
  persistNow();
  if (beacon && navigator.sendBeacon) {
    const ok = navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
    if (!ok) { _queue.unshift(...batch); persistNow(); }
    return;
  }
  try {
    const r = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    if (!r.ok) { _queue.unshift(...batch); persistNow(); }
  } catch { _queue.unshift(...batch); persistNow(); }
}

export function isImageLoggingOn(): boolean {
  try { return !!(JSON.parse(localStorage.getItem('menuvoice.profile.v1') ?? '{}') as { imageLogging?: boolean }).imageLogging; } catch { return false; }
}

export function initTelemetry() {
  // Merge in-memory pre-init events with any persisted queue so neither is lost.
  _queue = [...restore(), ..._queue];
  // Remove queue keys from closed sessions (those with a different session ID).
  try {
    const myKey = queueKey();
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(QUEUE_KEY_PREFIX + '.') && k !== myKey) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {}
  _t0 = Date.now();
  track('session', 'start');
  setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  // Writes are debounced off the tap path, so force one at every point the tab
  // could go away with events still only in memory.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { persistNow(); flush(true); }
  });
  window.addEventListener('pagehide', () => {
    track('session', 'end', { durationMs: Date.now() - _t0 });
    persistNow();
    flush(true);
  }, { capture: true });
}
