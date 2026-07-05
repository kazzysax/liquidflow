// TEMP local dev server so you can SEE the two payer interfaces in a browser.
// Serves the static .html pages and routes /api/* to the Vercel-style handlers,
// using the in-memory store. Seeds a demo merchant payment + a fundraiser on boot.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 4599;
const TYPES = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.ico':'image/x-icon' };

function resWrap(nodeRes) {
  return {
    statusCode: 200,
    setHeader: (k, v) => nodeRes.setHeader(k, v),
    status(c){ this.statusCode = c; return this; },
    json(obj){ nodeRes.writeHead(this.statusCode, { 'Content-Type':'application/json' }); nodeRes.end(JSON.stringify(obj)); },
    end(){ nodeRes.writeHead(this.statusCode); nodeRes.end(); },
  };
}

function resolveHandler(base, rest) {
  const tryPaths = [];
  if (rest) tryPaths.push(path.join(ROOT, 'api', base, rest + '.js'));
  if (rest) tryPaths.push(path.join(ROOT, 'api', base, '[id].js'));
  tryPaths.push(path.join(ROOT, 'api', base, 'index.js'));
  for (const p of tryPaths) { if (fs.existsSync(p)) return require(p); }
  return null;
}

const server = http.createServer(async (req, nodeRes) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = u.pathname;

  // ---- API ----
  if (pathname.startsWith('/api/')) {
    const parts = pathname.slice(5).split('/').filter(Boolean);
    const handler = resolveHandler(parts[0], parts[1]);
    if (!handler) { nodeRes.writeHead(404); return nodeRes.end('no route'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const query = Object.fromEntries(u.searchParams);
      if (parts[1] && !fs.existsSync(path.join(ROOT,'api',parts[0],parts[1]+'.js'))) query.id = parts[1];
      let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch (_) {}
      const fake = { method: req.method, headers: req.headers, query, body: parsed };
      try { await handler(fake, resWrap(nodeRes)); }
      catch (e) { nodeRes.writeHead(500); nodeRes.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ---- static ----
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(ROOT, decodeURIComponent(file));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    nodeRes.writeHead(404); return nodeRes.end('not found');
  }
  nodeRes.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
  nodeRes.end(fs.readFileSync(full));
});

server.listen(PORT, async () => {
  const store = require('./api/_lib/store');
  const base = `http://localhost:${PORT}`;
  const j = async (p, opt) => (await fetch(base + p, opt)).json();

  // 1) merchant (stealth → fresh unique deposit address per payment) → activate → sample payment
  const m = await j('/api/merchants', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'Aurora Store', mode:'stealth', webhook:'https://example.com/hook' }) });
  const rec = await store.get(`merchant:${m.api_key}`); rec.status='active'; await store.set(`merchant:${m.api_key}`, rec);
  const pay = await j('/api/payments', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+m.api_key},
    body: JSON.stringify({ amount:'1500000', asset:'USDC', chain:'eip155:5042002', label:'Order #1024 — Pro plan' }) });

  // 2) fundraiser (for the Potlock donation page)
  const fr = await j('/api/fundraisers', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title:'Open Source Grants', goal:2, chain:'eip155:84532' }) });

  console.log('\n=== Liquid Flow demo server on ' + base + ' ===');
  console.log('\n[1] CHECKOUT — what a payer from another platform sees:');
  console.log('    ' + base + '/pay.html?id=' + pay.payment_id);
  console.log('\n[2] POTLOCK — public donation interface (by id):');
  console.log('    ' + base + '/potlock-private.html?id=' + fr.id);
  console.log('\n(Ctrl+C to stop)\n');
});
