// Shared logic for the morning report: pull the data, render it, send it.
// Used by api/morning.ts (on-demand view) and api/cron-morning.ts (daily email).
// Underscore prefix => Vercel does not expose this as an HTTP route.

import { Redis } from '@upstash/redis';
import { createClient } from '@vercel/postgres';
import { cartesiaConfiguredKeyCount, getCartesiaStatus, type CartesiaStatus } from './_cartesiaStatus.js';
import { excludeList, excludePatternList } from './_reportExclusions.js';
// nodemailer is imported lazily inside sendEmail() (its only use). A top-level
// import pulls it into module load for EVERY consumer of this file — including the
// /api/morning and /api/dashboard view endpoints — and nodemailer failing to load
// in the Vercel runtime crashed those functions (FUNCTION_INVOCATION_FAILED).

export interface UserRow {
  user_email: string;
  events: number;
  sessions: number;
  first_in_window: string;
  last_in_window: string;
  failures: number;
  screens: string[] | null;
  menus: number;       // menus analyzed (ocr_result)
  questions: number;   // assistant replies (llm_reply)
  saves: number;       // restaurants saved
  finds: number;       // find-by-name searches
  first_ts: string;
  lifetime_sessions: number;
  is_new: boolean;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  prev: number;
}

export interface FunnelFailure {
  key: string;
  label: string;
  count: number;
  prev: number;
}

export interface Funnel {
  sessions: number;
  prevSessions: number;
  stages: FunnelStage[];
  failures: FunnelFailure[];
  biggestLeak: { fromLabel: string; toLabel: string; lost: number; pct: number } | null;
}

export interface WebsiteSignup {
  email: string;
  ts: string;
  referrer?: string | null;
}

export interface WebsiteFeedback {
  name: string;
  email: string;
  feedbackType: string;
  message: string;
  contactOk: boolean;
  ts: string;
  referrer?: string | null;
}

export interface WebsiteReport {
  available: boolean;
  visits: number;
  sessions: number;
  signups: number;
  feedback: number;
  referrers: { referrer: string; count: number }[];
  latestSignups: WebsiteSignup[];
  latestFeedback: WebsiteFeedback[];
}

export interface MorningData {
  windowLabel: string;
  hours: number;
  generated: string;
  anyoneUsed: boolean;
  // Headline totals, derived only from identified users (no anonymous noise).
  totals: { users: number; sessions: number; events: number; failures: number; dataFrom: string; dataTo: string };
  newUsers: UserRow[];
  returningUsers: UserRow[];
  excluded: string[];
  // The immediately preceding window of the same length (e.g. the prior 24h),
  // so each report can show what changed vs "yesterday" and never reads identical.
  prev: { users: number; sessions: number; events: number; newUsers: number };
  deltas: { users: number; sessions: number; events: number; newUsers: number };
  funnel: Funnel;
  website: WebsiteReport;
  cartesia: CartesiaStatus;
}

// Exact accounts and account-prefix rules live in _reportExclusions so the morning
// report and dashboard always hide the same internal/test identities.
// Who receives the daily email. The primary recipient(s) come from REPORT_EMAIL_TO
// (a Vercel env var; defaults to the owner account). Additional recipients are
// merged in from REPORT_EMAIL_EXTRA (defaults to the testers who asked to receive
// the report). Combining them additively means we never have to overwrite — and
// risk dropping — whatever REPORT_EMAIL_TO already holds. Returns a de-duplicated,
// comma-joined string suitable for both nodemailer and (after splitting) Resend.
export function resolveRecipients(): string {
  const primary = (process.env.REPORT_EMAIL_TO ?? '2firemaster27@gmail.com')
    .split(',').map((e) => e.trim()).filter(Boolean);
  // anibabug + ik8072369 are testers who want the report but are excluded from its
  // contents (see excludeList). mibrahim.dev17 is intentionally NOT here — excluded
  // from the report but not emailed it.
  const extra = (process.env.REPORT_EMAIL_EXTRA ?? 'anibabug@gmail.com,ik8072369@gmail.com')
    .split(',').map((e) => e.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of [...primary, ...extra]) {
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out.join(', ');
}

// Build a keyed, one-click analytics URL for links inside the email, so a recipient
// who already gets the report can open the dashboard without ever seeing the "enter
// the key" page. Uses the stable production alias (override with REPORT_PUBLIC_HOST)
// rather than the request host — a cron send's host header is a bare per-deployment
// URL, which is ugly and tied to one deployment. Returns undefined only when
// REPORT_KEY is unset — we omit the link rather than send one that can't work.
export function analyticsUrl(path: string): string | undefined {
  const key = process.env.REPORT_KEY?.trim();
  if (!key) return undefined;
  const base = process.env.REPORT_PUBLIC_HOST || 'app.meetmymenu.com';
  return `https://${base}${path}?key=${encodeURIComponent(key)}`;
}

const STAGE_DEFS: { key: string; label: string }[] = [
  { key: 'sessions', label: 'Session started' },
  { key: 'camera',   label: 'Camera opened' },
  { key: 'photo',    label: 'Photo captured' },
  { key: 'analyze',  label: 'Analysis started' },
  { key: 'ocr',      label: 'Menu extracted' },
  { key: 'answered', label: 'Got an answer' },
  { key: 'saved',    label: 'Restaurant saved' },
];

const FAIL_DEFS: { key: string; label: string }[] = [
  { key: 'fail_camera', label: 'camera' },
  { key: 'fail_ocr',    label: 'OCR' },
  { key: 'fail_ask',    label: 'ask' },
  { key: 'fail_stt',    label: 'speech' },
];

async function queryFunnelRow(
  client: ReturnType<typeof createClient>,
  exclude: string[],
  excludePatterns: string[],
  windowSql: string,
): Promise<Record<string, number>> {
  const q = await client.query(
    `WITH sess AS (
       SELECT session_id,
              bool_or(lower(user_email) = ANY($1::text[])
                OR lower(user_email) ~ ANY($2::text[]))                            AS internal,
              bool_or(event_name='camera_start' AND outcome IS DISTINCT FROM 'failure') AS r_camera,
              bool_or(event_name='photo_added')                                  AS r_photo,
              bool_or(event_name='analyze_start')                                AS r_analyze,
              bool_or(event_name='ocr_result' AND outcome IS DISTINCT FROM 'failure')   AS r_ocr,
              bool_or(event_name='llm_reply')                                    AS r_answered,
              bool_or(event_name='saved')                                        AS r_saved
       FROM events
       WHERE ${windowSql}
       GROUP BY session_id
     ),
     fails AS (
       SELECT
         count(*) FILTER (WHERE event_name='camera_start' AND outcome='failure') AS fail_camera,
         count(*) FILTER (WHERE event_name='ocr_result'   AND outcome='failure') AS fail_ocr,
         count(*) FILTER (WHERE event_type='ask' AND event_name='error')         AS fail_ask,
         count(*) FILTER (WHERE event_name='stt_error')                          AS fail_stt
       FROM events
       WHERE ${windowSql}
         AND session_id NOT IN (SELECT session_id FROM sess WHERE internal)
     )
     SELECT
       (SELECT count(*) FROM sess WHERE NOT internal)                 AS sessions,
       (SELECT count(*) FROM sess WHERE NOT internal AND r_camera)    AS camera,
       (SELECT count(*) FROM sess WHERE NOT internal AND r_photo)     AS photo,
       (SELECT count(*) FROM sess WHERE NOT internal AND r_analyze)   AS analyze,
       (SELECT count(*) FROM sess WHERE NOT internal AND r_ocr)       AS ocr,
       (SELECT count(*) FROM sess WHERE NOT internal AND r_answered)  AS answered,
       (SELECT count(*) FROM sess WHERE NOT internal AND r_saved)     AS saved,
       fails.fail_camera, fails.fail_ocr, fails.fail_ask, fails.fail_stt
     FROM fails`,
    [exclude, excludePatterns]
  );
  const row = q.rows[0] ?? {};
  const out: Record<string, number> = {};
  for (const k of Object.keys(row)) out[k] = Number(row[k]) || 0;
  return out;
}

export async function withClient<T>(fn: (c: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function fmtTs(ts: unknown): string {
  if (!ts) return '';
  const d = new Date(ts as string);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export function ago(ts: unknown): string {
  if (!ts) return '';
  const then = new Date(ts as string).getTime();
  if (isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} mo ago` : `${Math.round(days / 365)} yr ago`;
}

export function esc(v: unknown): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One human-readable line of "what they did" for a user.
export function activity(u: UserRow): string {
  const parts: string[] = [];
  if (Number(u.menus) > 0) parts.push(`${u.menus} menu${Number(u.menus) === 1 ? '' : 's'} scanned`);
  if (Number(u.questions) > 0) parts.push(`${u.questions} question${Number(u.questions) === 1 ? '' : 's'} asked`);
  if (Number(u.finds) > 0) parts.push(`${u.finds} restaurant search${Number(u.finds) === 1 ? '' : 'es'}`);
  if (Number(u.saves) > 0) parts.push(`${u.saves} saved`);
  return parts.length ? parts.join(' · ') : 'browsed only';
}

function redisFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function parseJsonRow(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function cleanReferrer(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'direct';
  try {
    const u = new URL(value);
    return u.hostname || 'direct';
  } catch {
    return value.slice(0, 80);
  }
}

async function getWebsiteReport(hours: number): Promise<WebsiteReport> {
  const redis = redisFromEnv();
  if (!redis) {
    return { available: false, visits: 0, sessions: 0, signups: 0, feedback: 0, referrers: [], latestSignups: [], latestFeedback: [] };
  }

  const since = Date.now() - hours * 60 * 60 * 1000;
  try {
    const raw = await redis.lrange('menuvoice:site:events', 0, 9999);
    const rows = raw
      .map(parseJsonRow)
      .filter((row): row is Record<string, unknown> => {
        const ts = typeof row?.ts === 'string' ? Date.parse(row.ts) : NaN;
        return Number.isFinite(ts) && ts > since;
      });

    const visitRows = rows.filter((row) => row.event_name === 'page_view');
    const signupRows = rows.filter((row) => row.event_name === 'waitlist_submit');
    const feedbackRows = rows.filter((row) => row.event_name === 'feedback_submit');
    const sessionIds = new Set(
      rows
        .map((row) => (typeof row.session_id === 'string' ? row.session_id : ''))
        .filter(Boolean)
    );

    const refs = new Map<string, number>();
    for (const row of visitRows) {
      const ref = cleanReferrer(row.referrer);
      refs.set(ref, (refs.get(ref) ?? 0) + 1);
    }

    const latestSignups = signupRows
      .map((row) => {
        const metadata = row.metadata && typeof row.metadata === 'object'
          ? row.metadata as Record<string, unknown>
          : {};
        return {
          email: typeof row.email === 'string' ? row.email : typeof metadata.email === 'string' ? metadata.email : '',
          ts: typeof row.ts === 'string' ? row.ts : '',
          referrer: typeof row.referrer === 'string' ? cleanReferrer(row.referrer) : null,
        };
      })
      .filter((row) => row.email)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, 10);

    const latestFeedback = feedbackRows
      .map((row) => {
        const metadata = row.metadata && typeof row.metadata === 'object'
          ? row.metadata as Record<string, unknown>
          : {};
        return {
          name: typeof metadata.name === 'string' ? metadata.name : '',
          email: typeof metadata.email === 'string' ? metadata.email : '',
          feedbackType: typeof metadata.feedback_type === 'string' ? metadata.feedback_type : 'other',
          message: typeof metadata.message === 'string' ? metadata.message : '',
          contactOk: metadata.contact_ok === true,
          ts: typeof row.ts === 'string' ? row.ts : '',
          referrer: typeof row.referrer === 'string' ? cleanReferrer(row.referrer) : null,
        };
      })
      .filter((row) => row.message)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, 10);

    return {
      available: true,
      visits: visitRows.length,
      sessions: sessionIds.size,
      signups: signupRows.length,
      feedback: feedbackRows.length,
      referrers: Array.from(refs.entries())
        .map(([referrer, count]) => ({ referrer, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      latestSignups,
      latestFeedback,
    };
  } catch (err) {
    console.error('[morning] website report unavailable:', err);
    return { available: false, visits: 0, sessions: 0, signups: 0, feedback: 0, referrers: [], latestSignups: [], latestFeedback: [] };
  }
}

export async function buildMorningReport(hours: number): Promise<MorningData> {
  hours = Math.min(Math.max(hours, 1), 24 * 365);
  const exclude = excludeList();
  const excludePatterns = excludePatternList();
  const windowLabel = hours === 24 ? 'last 24 hours' : hours % 24 === 0 ? `last ${hours / 24} days` : `last ${hours} h`;
  const w = `now() - interval '${hours} hours'`;
  // Parameterized exclusion: $1 = exact emails; $2 = identity patterns. Safe
  // against injection and narrow enough to preserve non-test Avi names.
  // NOTE: a session's pre-login rows have NULL email; the per-user query keys off
  // the rows that DO carry the email, so a logged-in user is counted once — there
  // is no separate "anonymous session" double-count.
  const notExcluded = `lower(user_email) <> ALL($1::text[])
    AND NOT (lower(user_email) ~ ANY($2::text[]))`;
  const cartesiaPromise = getCartesiaStatus(cartesiaConfiguredKeyCount());

  return withClient(async (client) => {
    const websitePromise = getWebsiteReport(hours);
    const users = await client.query(
      `WITH win AS (
         SELECT user_email,
                count(*)                                   AS events,
                count(DISTINCT session_id)                 AS sessions,
                min(ts)                                    AS first_in_window,
                max(ts)                                    AS last_in_window,
                count(*) FILTER (WHERE outcome='failure')  AS failures,
                count(*) FILTER (WHERE event_name='ocr_result') AS menus,
                count(*) FILTER (WHERE event_name='llm_reply')  AS questions,
                count(*) FILTER (WHERE event_name='saved')      AS saves,
                count(*) FILTER (WHERE event_name IN ('search_start','find_by_name')) AS finds,
                array_agg(DISTINCT screen) FILTER (WHERE screen IS NOT NULL) AS screens
         FROM events
         WHERE user_email IS NOT NULL AND ${notExcluded} AND ts > ${w}
         GROUP BY user_email
       ),
       life AS (
         SELECT user_email, min(ts) AS first_ts, count(DISTINCT session_id) AS lifetime_sessions
         FROM events WHERE user_email IS NOT NULL AND ${notExcluded}
         GROUP BY user_email
       )
       SELECT win.*, life.first_ts, life.lifetime_sessions, (life.first_ts > ${w}) AS is_new
       FROM win JOIN life USING (user_email)
       ORDER BY is_new DESC, win.last_in_window DESC`,
      [exclude, excludePatterns]
    );

    // Previous window of equal length [now-2h, now-h] for day-over-day deltas.
    const prevQ = await client.query(
      `WITH life AS (
         SELECT user_email, min(ts) AS first_ts
         FROM events WHERE user_email IS NOT NULL AND ${notExcluded}
         GROUP BY user_email
       ),
       prev AS (
         SELECT user_email,
                count(*) AS events,
                count(DISTINCT session_id) AS sessions
         FROM events
         WHERE user_email IS NOT NULL AND ${notExcluded}
           AND ts >  now() - interval '${hours * 2} hours'
           AND ts <= now() - interval '${hours} hours'
         GROUP BY user_email
       )
       SELECT
         (SELECT count(*)                FROM prev)                         AS users,
         (SELECT coalesce(sum(sessions),0) FROM prev)                       AS sessions,
         (SELECT coalesce(sum(events),0)   FROM prev)                       AS events,
         (SELECT count(*) FROM life
            WHERE first_ts >  now() - interval '${hours * 2} hours'
              AND first_ts <= now() - interval '${hours} hours')           AS new_users`,
      [exclude, excludePatterns]
    );

    const [curF, prevF] = await Promise.all([
      queryFunnelRow(client, exclude, excludePatterns, `ts > ${w}`),
      queryFunnelRow(client, exclude, excludePatterns,
        `ts > now() - interval '${hours * 2} hours' AND ts <= now() - interval '${hours} hours'`),
    ]);

    const rows = users.rows as UserRow[];
    const num = (v: unknown) => Number(v) || 0;
    const totals = {
      users: rows.length,
      sessions: rows.reduce((a, u) => a + num(u.sessions), 0),
      events: rows.reduce((a, u) => a + num(u.events), 0),
      failures: rows.reduce((a, u) => a + num(u.failures), 0),
      dataFrom: rows.length ? fmtTs(rows.reduce((min, u) => (u.first_in_window < min ? u.first_in_window : min), rows[0].first_in_window)) : '',
      dataTo: rows.length ? fmtTs(rows.reduce((max, u) => (u.last_in_window > max ? u.last_in_window : max), rows[0].last_in_window)) : '',
    };

    const pr = prevQ.rows[0] ?? {};
    const prev = {
      users: num(pr.users),
      sessions: num(pr.sessions),
      events: num(pr.events),
      newUsers: num(pr.new_users),
    };
    const newUsers = rows.filter((u) => u.is_new);
    const deltas = {
      users: totals.users - prev.users,
      sessions: totals.sessions - prev.sessions,
      events: totals.events - prev.events,
      newUsers: newUsers.length - prev.newUsers,
    };

    const stages: FunnelStage[] = STAGE_DEFS.map((def) => ({
      key: def.key, label: def.label, count: curF[def.key] ?? 0, prev: prevF[def.key] ?? 0,
    }));
    const failures: FunnelFailure[] = FAIL_DEFS.map((def) => ({
      key: def.key, label: def.label, count: curF[def.key] ?? 0, prev: prevF[def.key] ?? 0,
    }));

    let biggestLeak: Funnel['biggestLeak'] = null;
    for (let i = 1; i < stages.length; i++) {
      const from = stages[i - 1], to = stages[i];
      if (from.count <= 0) continue;
      const lost = from.count - to.count;
      if (lost > 0 && (!biggestLeak || lost > biggestLeak.lost)) {
        biggestLeak = { fromLabel: from.label, toLabel: to.label, lost, pct: lost / from.count };
      }
    }

    const funnel: Funnel = {
      sessions: curF.sessions ?? 0,
      prevSessions: prevF.sessions ?? 0,
      stages, failures, biggestLeak,
    };
    const website = await websitePromise;
    const cartesia = await cartesiaPromise;

    return {
      windowLabel,
      hours,
      generated: fmtTs(new Date().toISOString()),
      anyoneUsed: rows.length > 0 || website.visits > 0 || website.signups > 0,
      totals,
      newUsers,
      returningUsers: rows.filter((u) => !u.is_new),
      excluded: [...exclude, 'avi plus optional numbers'],
      prev,
      deltas,
      funnel,
      website,
      cartesia,
    };
  });
}

// ---- Renderers ----

// "vs previous 24 hours" / "vs yesterday" label for the comparison line.
function comparePeriod(d: MorningData): string {
  if (d.hours === 24) return 'yesterday';
  if (d.hours % 24 === 0) return `previous ${d.hours / 24} days`;
  return `previous ${d.hours}h`;
}

// "+3", "-1", "no change" — signed delta for plain text.
function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return '±0';
}

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '0%';
}

export function renderFunnelText(f: Funnel): string {
  if (f.sessions <= 0) return '';
  const lines: string[] = [];
  lines.push('WHERE SESSIONS DROPPED OFF:');
  for (const s of f.stages) {
    const delta = s.count - s.prev;
    const pctStr = s.key === 'sessions' ? '' : `  (${pct(s.count, f.sessions)})`;
    lines.push(`  ${s.label.padEnd(18)} ${String(s.count).padStart(3)}${pctStr}   ${signed(delta)} vs prev`);
  }
  if (f.biggestLeak) {
    const b = f.biggestLeak;
    lines.push(`  Biggest drop-off: ${b.fromLabel} to ${b.toLabel} (lost ${b.lost}, ${Math.round(b.pct * 100)}%)`);
  }
  const fail = f.failures
    .map((x) => `${x.label} ${x.count} (${signed(x.count - x.prev)})`)
    .join(' . ');
  lines.push(`  Failures: ${fail}`);
  return lines.join('\n');
}

export function renderWebsiteText(w: WebsiteReport): string {
  if (!w.available) return 'WEBSITE:\n  Not connected to the waitlist Redis store in this deployment.';
  const lines: string[] = [];
  lines.push('WEBSITE:');
  lines.push(`  ${w.sessions} unique site visitor(s), ${w.visits} page view(s), ${w.signups} waitlist/demo request(s), ${w.feedback} feedback submission(s)`);
  if (w.referrers.length) {
    lines.push(`  Referrers: ${w.referrers.map((r) => `${r.referrer} ${r.count}`).join(', ')}`);
  }
  if (w.latestSignups.length) {
    lines.push('  Latest signups:');
    for (const s of w.latestSignups) {
      lines.push(`  - ${s.email}  |  ${fmtTs(s.ts)}${s.referrer ? `  |  ${s.referrer}` : ''}`);
    }
  }
  if (w.latestFeedback.length) {
    lines.push('  Latest feedback:');
    for (const f of w.latestFeedback) {
      const from = f.name || f.email || 'Anonymous';
      const followUp = f.contactOk && f.email ? `  |  follow up: ${f.email}` : '';
      lines.push(`  - ${from}  |  ${f.feedbackType}  |  ${fmtTs(f.ts)}${followUp}`);
      lines.push(`    ${f.message}`);
    }
  }
  return lines.join('\n');
}

export function renderText(d: MorningData): string {
  const t = d.totals;
  const lines: string[] = [];
  const appUsed = t.users > 0;
  lines.push(`Meet My Menu AI morning report  (${d.windowLabel})`);
  lines.push(`generated ${d.generated}`);
  lines.push('');
  if (!d.anyoneUsed) {
    lines.push('No one used Meet My Menu AI in this window.');
  } else {
    if (appUsed) {
      lines.push(`Yes, the Meet My Menu AI app was used by ${t.users} ${t.users === 1 ? 'person' : 'people'}.`);
      lines.push(`  ${t.sessions} session(s), ${t.events} event(s), ${t.failures} failure(s)`);
      lines.push(`  vs ${comparePeriod(d)}: users ${signed(d.deltas.users)}, actions ${signed(d.deltas.events)}, new users ${signed(d.deltas.newUsers)}`);
      const funnelTxt = renderFunnelText(d.funnel);
      if (funnelTxt) { lines.push(''); lines.push(funnelTxt); }
    } else {
      lines.push('No identified users used the Meet My Menu AI app in this window.');
    }
    lines.push('');
    lines.push(renderWebsiteText(d.website));
    lines.push('');
    lines.push(`NEW users (${d.newUsers.length}):`);
    if (!d.newUsers.length) lines.push('  (none)');
    for (const u of d.newUsers) {
      lines.push(`  - ${u.user_email}  |  ${u.sessions} session(s)  |  ${activity(u)}  |  first seen ${fmtTs(u.first_in_window)}`);
    }
    lines.push('');
    lines.push(`Returning users (${d.returningUsers.length}):`);
    if (!d.returningUsers.length) lines.push('  (none)');
    for (const u of d.returningUsers) {
      lines.push(`  - ${u.user_email}  |  ${u.sessions} session(s) now / ${u.lifetime_sessions} lifetime  |  ${activity(u)}  |  joined ${ago(u.first_ts)}`);
    }
  }
  lines.push('');
  if (d.excluded.length) lines.push(`(excluded internal accounts: ${d.excluded.join(', ')})`);
  lines.push('');
  lines.push(renderCartesiaText(d.cartesia));
  return lines.join('\n');
}

function dateOnly(ts: string | null): string {
  return ts ? ts.slice(0, 10) : 'unknown';
}

export function renderCartesiaText(status: CartesiaStatus): string {
  const lines = ['CARTESIA API KEYS:'];
  if (!status.configured) {
    lines.push('  No Cartesia API keys are configured.');
    return lines.join('\n');
  }
  if (status.allExhausted) {
    lines.push(`  OUT OF CARTESIA KEYS${status.allExhaustedAt ? ` since ${fmtTs(status.allExhaustedAt)}` : ''}. OpenAI fallback is active.`);
  } else {
    const active = status.activeEmail
      ? `${status.activeEmail}${status.activeLabel ? ` (${status.activeLabel})` : ''}`
      : status.activeLabel ?? 'not observed yet';
    lines.push(`  Active: ${active}${status.activeSince ? ` since ${fmtTs(status.activeSince)}` : ''}`);
  }
  lines.push(`  Remaining after active key: ${status.remainingAfterActive}`);
  if (status.lastSwitchedAt) lines.push(`  Last switched: ${fmtTs(status.lastSwitchedAt)} (${ago(status.lastSwitchedAt)})`);
  for (const key of status.keys.filter((k) => k.status === 'exhausted')) {
    lines.push(`  Used: ${key.label} — exhausted ${fmtTs(key.exhaustedAt)}; estimated return ${fmtTs(key.availableAt)}`);
  }
  if (status.firstReturnsAt) lines.push(`  First key estimated back: ${fmtTs(status.firstReturnsAt)}`);
  if (status.projectedRunOutAt) {
    lines.push(`  At the recent rate, ${status.activeLabel} might run out on ${dateOnly(status.projectedRunOutAt)} (${status.projectionBasis}).`);
  }
  lines.push('  Full account breakdown:');
  for (const key of status.keys) {
    const account = key.email ? `${key.email} (${key.label})` : key.label;
    const approximate = key.credits.state === 'tracked' ? 'estimated ' : '';
    const remaining = key.credits.remaining == null ? 'unknown' : key.credits.remaining.toLocaleString('en-US');
    const used = key.credits.used == null ? 'unknown' : key.credits.used.toLocaleString('en-US');
    const limit = key.credits.limit == null ? 'unknown' : key.credits.limit.toLocaleString('en-US');
    lines.push(`    ${account} | ${key.status} | ${approximate}${remaining} credits left of ${limit} | ${approximate}${used} used`);
  }
  if (status.storage === 'memory') lines.push('  Status history is temporary until Redis/KV is configured.');
  return lines.join('\n');
}

export function renderCartesiaEmailHtml(status: CartesiaStatus, ff: string): string {
  const tone = status.allExhausted ? C.red : status.activeSlot ? C.greenDk : C.amber;
  const active = status.activeEmail
    ? `${status.activeEmail}${status.activeLabel ? ` (${status.activeLabel})` : ''}`
    : status.activeLabel;
  const heading = status.allExhausted
    ? 'All Cartesia keys are exhausted'
    : active
      ? `${active} is active`
      : 'No Cartesia key use observed yet';
  const used = status.keys.filter((k) => k.status === 'exhausted');
  const breakdown = status.keys.map((key) => {
    const account = key.email ? `${key.email} (${key.label})` : key.label;
    const source = key.credits.state === 'tracked' ? 'Meet My Menu AI tracked estimate' : 'Cartesia usage API';
    const remaining = key.credits.remaining == null ? 'unknown' : key.credits.remaining.toLocaleString('en-US');
    const usedCredits = key.credits.used == null ? 'unknown' : key.credits.used.toLocaleString('en-US');
    const limit = key.credits.limit == null ? 'unknown' : key.credits.limit.toLocaleString('en-US');
    return `<div style="border-top:1px solid ${C.line};padding:9px 0 7px">
      <strong style="color:${C.ink}">${esc(account)}</strong><br>
      <span style="color:${C.sub}">${esc(key.status)} &middot; ${esc(remaining)} credits left of ${esc(limit)} &middot; ${esc(usedCredits)} used<br>${esc(source)}</span>
    </div>`;
  }).join('');
  return `<tr><td style="padding-top:26px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:2px solid ${tone};border-radius:12px">
      <tr><td style="padding:15px 17px;font-family:${ff}">
        <div style="font-size:12px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:${tone}">Cartesia API keys</div>
        <div style="font-size:18px;font-weight:800;color:${C.ink};margin-top:3px">${esc(heading)}</div>
        <div style="font-size:13px;color:${C.sub};line-height:1.6;margin-top:6px">
          ${status.activeSince ? `Active since ${esc(fmtTs(status.activeSince))}.<br>` : ''}
          ${status.lastSwitchedAt ? `Last switched ${esc(fmtTs(status.lastSwitchedAt))} (${esc(ago(status.lastSwitchedAt))}).<br>` : ''}
          ${status.remainingAfterActive} key${status.remainingAfterActive === 1 ? '' : 's'} remaining after the active key.<br>
          ${used.map((k) => `${esc(k.label)} used — exhausted ${esc(fmtTs(k.exhaustedAt))}; estimated return ${esc(fmtTs(k.availableAt))}.<br>`).join('')}
          ${status.firstReturnsAt ? `First key estimated back: ${esc(fmtTs(status.firstReturnsAt))}.<br>` : ''}
          ${status.projectedRunOutAt ? `<strong>At the recent rate, ${esc(status.activeLabel)} might run out on ${esc(dateOnly(status.projectedRunOutAt))}.</strong><br>` : ''}
          ${status.allExhausted ? '<strong>OpenAI fallback is active.</strong>' : ''}
        </div>
        <div style="font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:${C.sub};margin-top:14px">Full account breakdown</div>
        <div style="font-size:13px;line-height:1.5">${breakdown}</div>
      </td></tr>
    </table>
  </td></tr>`;
}

// Palette
const C = {
  ink: '#0f172a', sub: '#64748b', line: '#e2e8f0', bg: '#f1f5f9',
  green: '#16a766', greenDk: '#0f7a4a', greenBg: '#e9f7f0',
  red: '#c0392b', redBg: '#fdecea', amber: '#b45309',
  card: '#ffffff', newBadge: '#16a766', retBadge: '#3b82f6',
};

function userCard(u: UserRow, kind: 'new' | 'returning'): string {
  const badge = kind === 'new'
    ? `<span style="display:inline-block;background:${C.newBadge};color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 8px;border-radius:999px;text-transform:uppercase">New</span>`
    : `<span style="display:inline-block;background:${C.retBadge};color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 8px;border-radius:999px;text-transform:uppercase">Returning</span>`;
  const meta = kind === 'new'
    ? `${u.sessions} session${Number(u.sessions) === 1 ? '' : 's'} &middot; first seen ${esc(fmtTs(u.first_in_window))}`
    : `${u.sessions} session${Number(u.sessions) === 1 ? '' : 's'} now &middot; ${esc(u.lifetime_sessions)} lifetime &middot; joined ${esc(ago(u.first_ts))}`;
  return `
  <tr><td style="padding:0 0 10px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px">
      <tr><td style="padding:14px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:15px;font-weight:700;color:${C.ink};font-family:Segoe UI,system-ui,-apple-system,sans-serif">${esc(u.user_email)}</td>
          <td align="right">${badge}</td>
        </tr></table>
        <div style="font-size:14px;color:${C.ink};margin:6px 0 4px;font-family:Segoe UI,system-ui,-apple-system,sans-serif">${esc(activity(u))}</div>
        <div style="font-size:12px;color:${C.sub};font-family:Segoe UI,system-ui,-apple-system,sans-serif">${meta}</div>
      </td></tr>
    </table>
  </td></tr>`;
}

export function renderFunnelHtml(f: Funnel, ff: string): string {
  if (f.sessions <= 0) return '';

  const deltaChip = (n: number) => {
    const up = n > 0, down = n < 0;
    const fg = up ? C.greenDk : down ? C.red : C.sub;
    const arrow = up ? '&#9650;' : down ? '&#9660;' : '&#8211;';
    const val = n === 0 ? '0' : `${n > 0 ? '+' : ''}${n}`;
    return `<span style="font-size:11px;font-weight:700;color:${fg};white-space:nowrap">${arrow} ${val}</span>`;
  };

  const rows = f.stages.map((s) => {
    const p = s.key === 'sessions' ? 100 : (f.sessions > 0 ? Math.round((s.count / f.sessions) * 100) : 0);
    const delta = s.count - s.prev;
    const isLeak = !!f.biggestLeak && f.biggestLeak.toLabel === s.label;
    const barColor = isLeak ? C.red : C.green;
    return `
    <tr>
      <td style="padding:5px 8px 5px 0;font-family:${ff};font-size:13px;color:${C.ink};white-space:nowrap">${esc(s.label)}</td>
      <td style="padding:5px 0;width:100%">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};border-radius:6px">
          <tr><td style="width:${p}%;background:${barColor};border-radius:6px;font-size:0;line-height:0">&nbsp;</td></tr>
        </table>
      </td>
      <td align="right" style="padding:5px 0 5px 10px;font-family:${ff};font-size:13px;font-weight:700;color:${C.ink};white-space:nowrap">${s.count}<span style="color:${C.sub};font-weight:600;font-size:11px"> ${s.key === 'sessions' ? '' : `&middot; ${p}%`}</span></td>
      <td align="right" style="padding:5px 0 5px 10px;white-space:nowrap">${deltaChip(delta)}</td>
    </tr>`;
  }).join('');

  const leak = f.biggestLeak
    ? `<div style="margin-top:8px;font-family:${ff};font-size:12px;color:${C.amber}">
         Biggest drop-off: <strong>${esc(f.biggestLeak.fromLabel)}</strong> to <strong>${esc(f.biggestLeak.toLabel)}</strong>
         (lost ${f.biggestLeak.lost}, ${Math.round(f.biggestLeak.pct * 100)}%)
       </div>`
    : '';

  const failChips = f.failures.map((x) => {
    const delta = x.count - x.prev;
    const fg = delta > 0 ? C.red : C.sub;
    return `<span style="display:inline-block;font-family:${ff};font-size:12px;color:${C.ink};margin-right:14px">
      ${esc(x.label)} <strong>${x.count}</strong> <span style="color:${fg};font-size:11px">(${delta === 0 ? '0' : `${delta > 0 ? '+' : ''}${delta}`})</span>
    </span>`;
  }).join('');

  return `
  <tr><td style="padding:26px 0 8px;font-family:${ff};font-size:15px;font-weight:800;color:${C.ink}">Where sessions dropped off</td></tr>
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px">
      <tr><td style="padding:14px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        ${leak}
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid ${C.line}">
          <div style="font-family:${ff};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.sub};margin-bottom:6px">Failures in window</div>
          ${failChips}
        </div>
      </td></tr>
    </table>
  </td></tr>`;
}

export function renderWebsiteHtml(w: WebsiteReport, ff: string): string {
  const unavailable = !w.available
    ? `<div style="font-family:${ff};font-size:12px;color:${C.amber};margin-top:8px">Website activity is not connected to the waitlist Redis store in this deployment.</div>`
    : '';
  const referrers = w.referrers.length
    ? `<div style="font-family:${ff};font-size:12px;color:${C.sub};margin-top:8px">Referrers: ${w.referrers.map((r) => `${esc(r.referrer)} ${r.count}`).join(', ')}</div>`
    : '';
  const signups = w.latestSignups.length
    ? `<div style="font-family:${ff};font-size:12px;color:${C.ink};margin-top:10px">
        <strong>Latest requests:</strong><br>
        ${w.latestSignups.map((s) => `${esc(s.email)} <span style="color:${C.sub}">${esc(fmtTs(s.ts))}${s.referrer ? ` &middot; ${esc(s.referrer)}` : ''}</span>`).join('<br>')}
       </div>`
    : '';

  const feedback = w.latestFeedback.length
    ? `<div style="font-family:${ff};font-size:12px;color:${C.ink};margin-top:14px"><strong>Latest feedback:</strong><br>${w.latestFeedback.map((f) => { const from = f.name || f.email || 'Anonymous'; const followUp = f.contactOk && f.email ? ` &middot; follow up: ${esc(f.email)}` : ''; return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid ${C.line}"><strong>${esc(from)}</strong> <span style="color:${C.sub}">&middot; ${esc(f.feedbackType)} &middot; ${esc(fmtTs(f.ts))}${followUp}</span><br><span style="white-space:pre-wrap">${esc(f.message)}</span></div>`; }).join('')}</div>` : '';

  return `
  <tr><td style="padding:26px 0 8px;font-family:${ff};font-size:15px;font-weight:800;color:${C.ink}">Public website</td></tr>
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px">
      <tr><td style="padding:14px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-family:${ff};font-size:13px;color:${C.sub};padding-right:10px"><div style="font-size:26px;font-weight:800;color:${C.ink};line-height:1">${w.sessions}</div>unique site visitors</td>
          <td style="font-family:${ff};font-size:13px;color:${C.sub};padding-right:10px"><div style="font-size:26px;font-weight:800;color:${C.ink};line-height:1">${w.visits}</div>page views</td>
          <td style="font-family:${ff};font-size:13px;color:${C.sub};padding-right:10px"><div style="font-size:26px;font-weight:800;color:${C.greenDk};line-height:1">${w.signups}</div>requests</td>
          <td style="font-family:${ff};font-size:13px;color:${C.sub}"><div style="font-size:26px;font-weight:800;color:${C.greenDk};line-height:1">${w.feedback}</div>feedback</td>
        </tr></table>
        ${unavailable}
        ${referrers}
        ${signups}
        ${feedback}
      </td></tr>
    </table>
  </td></tr>`;
}

export function renderEmailHtml(d: MorningData, links?: { dashboard?: string; report?: string }): string {
  const t = d.totals;
  const ff = 'Segoe UI,system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif';
  const appUsed = t.users > 0;

  const verdict = !d.anyoneUsed
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.redBg};border:1px solid ${C.red};border-radius:12px">
         <tr><td style="padding:16px 18px;font-family:${ff}">
           <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.red}">Quiet window</div>
           <div style="font-size:20px;font-weight:800;color:${C.ink};margin-top:2px">No app or website activity</div>
         </td></tr>
       </table>`
    : appUsed
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.greenBg};border:1px solid ${C.green};border-radius:12px">
         <tr><td style="padding:16px 18px;font-family:${ff}">
           <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.greenDk}">Yes — people used the app</div>
           <div style="font-size:28px;font-weight:800;color:${C.ink};margin-top:2px">${t.users} ${t.users === 1 ? 'person' : 'people'}</div>
           <div style="font-size:13px;color:${C.sub};margin-top:2px">${t.sessions} session${t.sessions === 1 ? '' : 's'} &middot; ${t.events} action${t.events === 1 ? '' : 's'}${Number(t.failures) > 0 ? ` &middot; <span style="color:${C.red}">${t.failures} failure${t.failures === 1 ? '' : 's'}</span>` : ''}</div>
         </td></tr>
       </table>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.greenBg};border:1px solid ${C.green};border-radius:12px">
         <tr><td style="padding:16px 18px;font-family:${ff}">
           <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.greenDk}">Website activity</div>
           <div style="font-size:20px;font-weight:800;color:${C.ink};margin-top:2px">No identified app users in this window</div>
         </td></tr>
       </table>`;

  // Day-over-day comparison strip: a green up-chip, red down-chip, or grey flat-chip
  // per metric so two consecutive reports never look identical.
  const chip = (label: string, n: number) => {
    const up = n > 0, down = n < 0;
    const bg = up ? C.greenBg : down ? C.redBg : '#eef2f7';
    const fg = up ? C.greenDk : down ? C.red : C.sub;
    const arrow = up ? '&#9650;' : down ? '&#9660;' : '&#8211;';
    const val = n === 0 ? '0' : `${n > 0 ? '+' : ''}${n}`;
    return `<td style="padding:0 4px"><div style="background:${bg};border-radius:8px;padding:7px 10px;font-family:${ff};text-align:center">
      <span style="font-size:13px;font-weight:800;color:${fg}">${arrow} ${val}</span>
      <span style="font-size:11px;color:${C.sub};margin-left:4px">${label}</span>
    </div></td>`;
  };
  const compareStrip = appUsed
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px -4px 0"><tr>
         <td colspan="3" style="padding:0 4px 6px;font-family:${ff};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.sub}">vs ${comparePeriod(d)}</td>
       </tr><tr>
         ${chip('users', d.deltas.users)}
         ${chip('actions', d.deltas.events)}
         ${chip('new', d.deltas.newUsers)}
       </tr></table>`
    : '';

  const tile = (label: string, value: number, accent: string) =>
    `<td width="50%" style="padding:0 6px">
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:12px">
         <tr><td style="padding:14px 16px;font-family:${ff}">
           <div style="font-size:32px;font-weight:800;color:${accent};line-height:1">${value}</div>
           <div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.sub};margin-top:4px">${label}</div>
         </td></tr>
       </table>
     </td>`;

  const section = (title: string, rows: UserRow[], kind: 'new' | 'returning') => `
    <tr><td style="padding:26px 0 8px;font-family:${ff};font-size:15px;font-weight:800;color:${C.ink};letter-spacing:.01em">${title} <span style="color:${C.sub};font-weight:600">(${rows.length})</span></td></tr>
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows.length ? rows.map((u) => userCard(u, kind)).join('') : `<tr><td style="padding:12px 14px;background:${C.card};border:1px dashed ${C.line};border-radius:12px;color:${C.sub};font-size:13px;font-family:${ff}">None in this window.</td></tr>`}
      </table>
    </td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${C.bg}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%">

        <!-- header -->
        <tr><td style="background:${C.green};border-radius:14px 14px 0 0;padding:20px 22px;font-family:${ff}">
          <div style="font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#d6f5e6">Meet My Menu AI</div>
          <div style="font-size:22px;font-weight:800;color:#ffffff;margin-top:2px">Morning report</div>
          <div style="font-size:12px;color:#c7efdb;margin-top:4px">${esc(d.windowLabel)} &middot; generated ${esc(d.generated)}</div>
        </td></tr>

        <!-- body -->
        <tr><td style="background:${C.bg};padding:18px 18px 24px;border:1px solid ${C.line};border-top:none;border-radius:0 0 14px 14px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td>${verdict}</td></tr>
            ${compareStrip ? `<tr><td>${compareStrip}</td></tr>` : ''}
            <tr><td style="padding-top:12px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px"><tr>
                ${tile('New users', d.newUsers.length, C.newBadge)}
                ${tile('Returning users', d.returningUsers.length, C.retBadge)}
              </tr></table>
            </td></tr>
            ${renderFunnelHtml(d.funnel, ff)}
            ${renderWebsiteHtml(d.website, ff)}
            ${section('New users', d.newUsers, 'new')}
            ${section('Returning users', d.returningUsers, 'returning')}
            ${(links?.dashboard || links?.report) ? `<tr><td style="padding-top:22px" align="center">
              ${links?.dashboard ? `<a href="${esc(links.dashboard)}" style="display:inline-block;background:${C.ink};color:#fff;text-decoration:none;font-family:${ff};font-size:14px;font-weight:600;padding:11px 22px;border-radius:10px">Open live analytics dashboard</a>` : ''}
              ${links?.report ? `<a href="${esc(links.report)}" style="display:inline-block;margin-left:8px;background:#fff;color:${C.ink};border:1px solid ${C.line};text-decoration:none;font-family:${ff};font-size:14px;font-weight:600;padding:10px 21px;border-radius:10px">View this report</a>` : ''}
            </td></tr>
            <tr><td style="padding-top:8px" align="center"><span style="font-family:${ff};font-size:11px;color:${C.sub}">These links include your private access key — no sign-in needed.</span></td></tr>` : ''}
            <tr><td style="padding-top:18px;font-family:${ff};font-size:11px;color:${C.sub};line-height:1.5">
              ${d.excluded.length ? `Internal/test accounts hidden: ${esc(d.excluded.join(', '))}.<br>` : ''}
              "New" = first-ever use in this window. "Returning" = used Meet My Menu AI before and came back.
            </td></tr>
            ${renderCartesiaEmailHtml(d.cartesia, ff)}
          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ---- Email delivery ----
// Prefers Resend (RESEND_API_KEY, no SMTP egress needed); falls back to Gmail
// SMTP (GMAIL_USER + GMAIL_APP_PASSWORD). Throws if neither is configured.
export async function sendEmail(opts: { to: string; subject: string; html: string; text: string }): Promise<string> {
  const { to, subject, html, text } = opts;

  if (process.env.RESEND_API_KEY) {
    const from = process.env.RESEND_FROM ?? 'Meet My Menu AI <onboarding@resend.dev>';
    // Resend wants an array of addresses; our `to` may be a comma-joined list.
    const toList = to.split(',').map((e) => e.trim()).filter(Boolean);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: toList, subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend failed: ${r.status} ${await r.text()}`);
    return 'resend';
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass) {
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
    await transport.sendMail({ from: user, to, subject, text, html });
    return 'gmail';
  }

  throw new Error('No email transport configured. Set RESEND_API_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD.');
}
