// KV abstraction: Upstash Redis in production; in-memory Map for local dev.
// Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Vercel Dashboard
// → Integrations → Upstash Redis (free tier available).

const mem = new Map();
let _client = null;
let _checked = false;

async function client() {
  if (_checked) return _client;
  _checked = true;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // In production the in-memory Map is per-serverless-instance and ephemeral: a
    // payment created on one instance is invisible to the instance that later
    // confirms it, and merchant lookups fail intermittently. Never silently run on
    // it in prod — fail loudly so the deployment is fixed instead of losing money data.
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error('[store] UPSTASH_REDIS_REST_URL / _TOKEN are required in production — refusing to use the ephemeral in-memory store');
    }
    console.warn('[store] Redis env vars not set — using in-memory store (dev only, not persistent)');
    return null;
  }
  try {
    const { Redis } = await import('@upstash/redis');
    _client = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return _client;
  } catch (e) {
    console.warn('[store] @upstash/redis failed —', e.message);
    return null;
  }
}

async function get(key) {
  const c = await client();
  return c ? c.get(key) : (mem.get(key) ?? null);
}

async function set(key, value) {
  const c = await client();
  if (c) return c.set(key, value);
  mem.set(key, value);
}

async function del(key) {
  const c = await client();
  if (c) return c.del(key);
  mem.delete(key);
}

async function sadd(key, member) {
  const c = await client();
  if (c) return c.sadd(key, member);
  const s = mem.get(key) || [];
  if (!s.includes(member)) s.push(member);
  mem.set(key, s);
}

async function srem(key, member) {
  const c = await client();
  if (c) return c.srem(key, member);
  mem.set(key, (mem.get(key) || []).filter(x => x !== member));
}

async function smembers(key) {
  const c = await client();
  return c ? c.smembers(key) : (mem.get(key) || []);
}

module.exports = { get, set, del, sadd, srem, smembers };
