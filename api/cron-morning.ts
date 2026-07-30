// GET /api/cron-morning   ->  builds the morning report and EMAILS it.
//
// Triggered automatically by Vercel Cron (see vercel.json "crons"). Vercel sends
// `Authorization: Bearer $CRON_SECRET` on scheduled invocations; we verify it.
// You can also trigger manually with ?key=<REPORT_KEY> (e.g. to test delivery).
//
// Recipients: REPORT_EMAIL_TO (defaults to 2firemaster27@gmail.com) plus the
//             extra testers in REPORT_EMAIL_EXTRA — see resolveRecipients().
// Transport:  RESEND_API_KEY  OR  GMAIL_USER + GMAIL_APP_PASSWORD  (see _morningData.sendEmail)
// Window:     REPORT_EMAIL_HOURS (default 24).  ?hours= overrides for manual runs.
//
// Internal/test accounts are excluded via REPORT_EXCLUDE_EMAILS.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildMorningReport, renderText, renderEmailHtml, sendEmail, resolveRecipients, analyticsUrl } from './_morningData.js';

export function shouldSendMorningReport(
  data: { totals: { users: number }; website: { sessions: number; signups?: number; feedback?: number } },
  force = false,
): boolean {
  // Passive website visits stay in analytics, but do not send email. Only an
  // identified app user, a waitlist/demo signup, feedback, or a manual override does.
  return force || data.totals.users > 0 || (data.website.signups ?? 0) > 0 || (data.website.feedback ?? 0) > 0;
}

function authorized(req: VercelRequest): boolean {
  const auth = (req.headers.authorization as string) ?? '';
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  if (process.env.REPORT_KEY && (req.query.key as string) === process.env.REPORT_KEY.trim()) return true;
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const to = resolveRecipients();
  const hoursRaw = Number(req.query.hours);
  const envHours = Number(process.env.REPORT_EMAIL_HOURS);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
    ? hoursRaw
    : Number.isFinite(envHours) && envHours > 0
      ? envHours
      : 24;

  // If no server-side transport is set, this path is a clean no-op (200) — the
  // active sender is the scheduled cloud agent hitting /api/morning?format=email.
  const hasTransport = !!(process.env.RESEND_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD));
  if (!hasTransport) {
    return res.status(200).json({ ok: true, sent: false, reason: 'no server transport configured; cloud agent handles delivery' });
  }

  try {
    const d = await buildMorningReport(hours);

    // Passive website views are still reported in analytics, but do not trigger
    // email. Append ?force=1 to override for a manual test send.
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!shouldSendMorningReport(d, force)) {
      return res.status(200).json({ ok: true, sent: false, reason: 'no app users or website signups in window — nothing new to email' });
    }

    const date = new Date().toISOString().slice(0, 10);
    // Stable, unique tag so a Gmail filter can label every report reliably.
    const subject = d.cartesia.allExhausted
      ? `[Meet My Menu AI] Morning report ${date} — Cartesia keys exhausted`
      : d.anyoneUsed
      ? `[Meet My Menu AI] Morning report ${date} — ${d.newUsers.length} new, ${d.returningUsers.length} returning, ${d.website.sessions} unique site visitors`
      : `[Meet My Menu AI] Morning report ${date} — no users in window`;

    const links = {
      dashboard: analyticsUrl('/api/dashboard'),
      report: analyticsUrl('/api/morning'),
    };

    const via = await sendEmail({
      to,
      subject,
      html: renderEmailHtml(d, links),
      text: renderText(d),
    });

    return res.status(200).json({
      ok: true,
      sent_to: to,
      via,
      window: d.windowLabel,
      new_users: d.newUsers.length,
      returning_users: d.returningUsers.length,
      unique_site_visitors: d.website.sessions,
      anyone_used: d.anyoneUsed,
    });
  } catch (err) {
    console.error('[cron-morning] error:', err);
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
