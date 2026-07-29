import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const CONTACT_TYPES = new Set(['diner', 'restaurant', 'accessibility_org', 'other']);

function originAllowed(req) {
  const host = req.headers.host;
  const src = req.headers.origin || req.headers.referer || '';
  if (!host || !src) return true;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

function rateLimitKey(req) {
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  const source = forwarded.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  return `menuvoice:waitlist:rate:${createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!originAllowed(req)) return res.status(403).json({ error: 'Invalid origin' });

  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const rateKey = rateLimitKey(req);
    const attempts = await redis.incr(rateKey);
    if (attempts === 1) await redis.expire(rateKey, 60);
    if (attempts > 10) return res.status(429).json({ error: 'Please wait a minute before trying again.' });

    const ts = new Date().toISOString();
    const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.slice(0, 128) : null;
    const path = typeof req.body?.path === 'string' ? req.body.path.slice(0, 256) : null;
    const referrer = typeof req.body?.referrer === 'string' ? req.body.referrer.slice(0, 512) : null;
    const contactTypeRaw = typeof req.body?.contact_type === 'string' ? req.body.contact_type : '';
    const contactType = CONTACT_TYPES.has(contactTypeRaw) ? contactTypeRaw : 'other';
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null;
    const record = { email, contact_type: contactType, ts, session_id: sessionId, path, referrer, user_agent: userAgent };

    await redis.sadd('menuvoice:waitlist', email);
    await redis.lpush('menuvoice:waitlist:log', JSON.stringify(record));
    await redis.ltrim('menuvoice:waitlist:log', 0, 9999);
    await redis.lpush('menuvoice:site:events', JSON.stringify({
      ts,
      event_name: 'waitlist_submit',
      session_id: sessionId,
      path,
      referrer,
      user_agent: userAgent,
      metadata: { contact_type: contactType },
    }));
    await redis.ltrim('menuvoice:site:events', 0, 9999);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Waitlist signup failed', error);
    return res.status(500).json({ error: 'Unable to save signup' });
  }
}
