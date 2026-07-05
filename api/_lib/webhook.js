// HMAC-signed webhook delivery — matches the scheme in merchant_api_demo.js
const crypto = require('crypto');

// SSRF guard: the webhook URL is merchant-controlled and we fetch it server-side,
// so a merchant could point it at internal infrastructure (localhost, cloud
// metadata at 169.254.169.254, RFC1918 ranges). Reject those hosts. Note: this
// blocks literal-IP and obvious-hostname abuse; it does not defeat DNS rebinding
// (a name resolving to a private IP), which needs resolve-then-pin at fetch time.
function isPublicHttpUrl(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') return false;
  const h = x.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '[::1]' || h === '::1') return false;
  if (h.endsWith('.internal') || h.endsWith('.local')) return false;
  // IPv4 literal ranges that must never be reachable from a webhook.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return false;            // loopback / private / this-host
    if (a === 169 && b === 254) return false;                       // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;              // private
    if (a === 192 && b === 168) return false;                       // private
    if (a === 100 && b >= 64 && b <= 127) return false;             // CGNAT
    if (a >= 224) return false;                                     // multicast / reserved
  }
  // Any IPv6 literal is rejected (covers ::1, fc00::/7 ULA, fe80::/10 link-local).
  if (h.includes(':')) return false;
  return true;
}

function sign(secret, ts, body) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function verify(secret, ts, body, sig) {
  if (!sig || sig.length < 10) return false;
  const expected = sign(secret, ts, body);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function send(url, secret, event) {
  if (!url) return;
  if (!isPublicHttpUrl(url)) { console.error('[webhook] refusing to deliver to non-public URL', url); return; }
  const body = JSON.stringify(event);
  const ts   = Date.now();
  const sig  = sign(secret, ts, body);
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000);
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'LF-Signature': `t=${ts},v1=${sig}`,
        'LF-Webhook-Id': crypto.randomBytes(8).toString('hex'),
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    console.error('[webhook] delivery failed to', url, e.message);
  }
}

module.exports = { sign, verify, send, isPublicHttpUrl };
