import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const FEEDBACK_TYPES = new Set(['used_app', 'tried_menu', 'accessibility', 'other']);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function originAllowed(req) {
  const host = req.headers.host;
  const source = req.headers.origin || req.headers.referer || '';
  if (!host || !source) return true;
  try { return new URL(source).host === host; } catch { return false; }
}

function rateLimitKey(req) {
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  const source = forwarded.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  return `menuvoice:feedback:rate:${createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!originAllowed(req)) return res.status(403).json({ error: 'Invalid origin' });
  const name = text(req.body?.name, 80);
  const email = text(req.body?.email, 254).toLowerCase();
  const feedbackType = text(req.body?.feedback_type, 32);
  const message = text(req.body?.message, 1500);
  const contactOk = req.body?.contact_ok === true;
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!FEEDBACK_TYPES.has(feedbackType)) return res.status(400).json({ error: 'Please choose what you are giving feedback about.' });
  if (message.length < 12) return res.status(400).json({ error: 'Please share a little more detail before sending.' });
  if (contactOk && !email) return res.status(400).json({ error: 'Please add an email address if you would like a follow-up.' });
  try {
    const rateKey = rateLimitKey(req);
    const attempts = await redis.incr(rateKey);
    if (attempts === 1) await redis.expire(rateKey, 60);
    if (attempts > 5) return res.status(429).json({ error: 'Please wait a minute before sending more feedback.' });
    const ts = new Date().toISOString();
    await redis.lpush('menuvoice:site:events', JSON.stringify({
      ts,
      event_name: 'feedback_submit',
      session_id: text(req.body?.session_id, 128) || null,
      path: text(req.body?.path, 256) || null,
      referrer: text(req.body?.referrer, 512) || null,
      user_agent: text(req.headers['user-agent'], 512) || null,
      metadata: { name, email, feedback_type: feedbackType, message, contact_ok: contactOk },
    }));
    await redis.ltrim('menuvoice:site:events', 0, 9999);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Feedback submission failed', error);
    return res.status(500).json({ error: 'Unable to save feedback. Please try again.' });
  }
}
