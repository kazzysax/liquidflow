// Server-side Verse App Analytics. Best-effort only: analytics can never block payment state.
const ENDPOINT = process.env.VERSE_ANALYTICS_ENDPOINT || 'https://analytics.vgdh.io/api/event';
const DOMAIN = process.env.VERSE_ANALYTICS_DOMAIN || 'liquidflow-io.vercel.app';

function sanitize(props) {
  const clean = {};
  for (const [key, value] of Object.entries(props || {}).slice(0, 12)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      clean[String(key).slice(0, 40)] = String(value).slice(0, 120);
    }
  }
  return clean;
}

async function trackVerseEvent(name, props = {}) {
  if (!name || process.env.DISABLE_VERSE_ANALYTICS === '1') return false;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LiquidFlow/1.0',
      },
      body: JSON.stringify({
        name: String(name).slice(0, 80),
        url: `https://${DOMAIN}/api`,
        domain: DOMAIN,
        props: sanitize(props),
      }),
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

module.exports = { trackVerseEvent, sanitize };
