// Liquid Flow — Merchant API + webhooks (runnable reference implementation).
//
// This is the API surface a builder integrates. It proves the core flows with
// real logic + crypto so the production Rust version has a concrete blueprint:
//   * POST /payments         create a payment, get a deposit address (gate or stealth)
//   * GET  /payments/:id      check status
//   * private R channel       stealth ephemeral key delivered to LF, never on-chain
//   * signed webhooks         HMAC-signed "payment.confirmed" the merchant verifies
//
// Run: node merchant_api_demo.js   (no external deps; uses Node http + crypto)

const http = require('http');
const crypto = require('crypto');

// ---- in-memory stores (production: Postgres, per the migrations) ----
const merchants = new Map(); // apiKey -> { id, webhookUrl, webhookSecret, mode, metaAddress }
const payments  = new Map(); // paymentId -> { merchantId, amount, asset, chain, status, depositAddress, R }

// seed one merchant (in production this comes from the onboarding wizard)
const API_KEY = 'lf_live_demo_key_123';
merchants.set(API_KEY, {
  id: 'm_abc',
  webhookUrl: 'http://localhost:9099/webhook',     // the merchant's endpoint
  webhookSecret: 'whsec_' + crypto.randomBytes(16).toString('hex'),
  mode: 'stealth',                                  // 'instant' | 'stealth'
  // published meta-address (public keys) for stealth mode — from the wizard
  metaAddress: { P_spend: 'pub_spend_demo', P_view: 'pub_view_demo' },
});

// ---- helpers ----
function json(res, code, obj){ res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj,null,2)); }
function auth(req){ const k=(req.headers['authorization']||'').replace('Bearer ',''); return merchants.get(k); }
function id(prefix){ return prefix+'_'+crypto.randomBytes(8).toString('hex'); }

// Derive a deposit address. In production: instant mode = the gate contract address;
// stealth mode = derived from metaAddress + ephemeral key (see stealth_payment_demo.js).
function deriveDeposit(merchant, paymentId){
  if (merchant.mode === 'instant') {
    return { depositAddress: '0xGATE_' + merchant.id, R: null };
  }
  // stealth: produce a representative fresh address + ephemeral key R (private channel)
  const eph = crypto.randomBytes(32).toString('hex');
  const addr = '0x' + crypto.createHash('sha256').update(eph + paymentId).digest('hex').slice(24);
  return { depositAddress: addr, R: eph };
}

// ---- signed webhook delivery (merchant verifies the signature) ----
function sendWebhook(merchant, event){
  const body = JSON.stringify(event);
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', merchant.webhookSecret).update(ts + '.' + body).digest('hex');
  // In production: POST with retries + backoff. Here we just log what would be sent.
  console.log('  -> webhook to', merchant.webhookUrl);
  console.log('     headers: LF-Signature: t=' + ts + ',v1=' + sig.slice(0,24) + '…');
  console.log('     body:', body);
  return { ts, sig, body };
}

// merchant-side verification (what the builder runs to trust the webhook)
function verifyWebhook(secret, ts, body, sig){
  const expected = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---- routes ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  // POST /payments
  if (req.method === 'POST' && parts[0]==='payments' && parts.length===1) {
    const m = auth(req); if(!m) return json(res,401,{error:'bad api key'});
    let raw=''; req.on('data',d=>raw+=d); req.on('end',()=>{
      let b={}; try{ b=JSON.parse(raw||'{}'); }catch{ return json(res,400,{error:'bad json'}); }
      const pid = id('pay');
      const { depositAddress, R } = deriveDeposit(m, pid);
      payments.set(pid, { merchantId:m.id, amount:b.amount, asset:b.asset, chain:b.chain,
        status:'awaiting_payment', depositAddress, R });
      // R stays server-side (private channel) — NOT returned to the payer/public.
      return json(res,201,{ payment_id:pid, deposit_address:depositAddress,
        amount:b.amount, asset:b.asset, chain:b.chain, status:'awaiting_payment',
        privacy_mode:m.mode });
    });
    return;
  }

  // GET /payments/:id
  if (req.method==='GET' && parts[0]==='payments' && parts[1]) {
    const m=auth(req); if(!m) return json(res,401,{error:'bad api key'});
    const p=payments.get(parts[1]); if(!p||p.merchantId!==m.id) return json(res,404,{error:'not found'});
    return json(res,200,{ payment_id:parts[1], status:p.status, deposit_address:p.depositAddress,
      amount:p.amount, asset:p.asset, chain:p.chain });
  }

  // POST /_simulate/confirm/:id  (test hook — the deposit-watcher would call this internally)
  if (req.method==='POST' && parts[0]==='_simulate' && parts[1]==='confirm' && parts[2]) {
    const p=payments.get(parts[2]); if(!p) return json(res,404,{error:'no payment'});
    p.status='confirmed';
    const m=[...merchants.values()].find(x=>x.id===p.merchantId);
    const wh=sendWebhook(m, { type:'payment.confirmed', payment_id:parts[2], amount:p.amount,
      asset:p.asset, chain:p.chain, confirmations:12, final:true });
    return json(res,200,{ ok:true, webhook_sent:true });
  }

  json(res,404,{error:'no route'});
});

// ---- self-test when run directly ----
if (require.main === module) {
  server.listen(9098, async () => {
    console.log('Merchant API on :9098  (mode = stealth)\n');
    const base='http://localhost:9098';
    const H={ 'Authorization':'Bearer '+API_KEY, 'Content-Type':'application/json' };

    console.log('--- 1. create a payment ---');
    const cr = await fetch(base+'/payments',{method:'POST',headers:H,body:JSON.stringify({amount:'50000000',asset:'USDC',chain:'eip155:8453'})}).then(r=>r.json());
    console.log('  created:', cr.payment_id, '\n  deposit_address:', cr.deposit_address, '\n  privacy_mode:', cr.privacy_mode);

    console.log('\n--- 2. check status (awaiting) ---');
    const st = await fetch(base+'/payments/'+cr.payment_id,{headers:H}).then(r=>r.json());
    console.log('  status:', st.status);

    console.log('\n--- 3. deposit-watcher confirms -> signed webhook fires ---');
    await fetch(base+'/_simulate/confirm/'+cr.payment_id,{method:'POST'}).then(r=>r.json());

    console.log('\n--- 4. merchant verifies the webhook signature ---');
    const m=merchants.get(API_KEY);
    const evt=JSON.stringify({type:'payment.confirmed',payment_id:cr.payment_id});
    const ts=Date.now();
    const goodSig=crypto.createHmac('sha256',m.webhookSecret).update(ts+'.'+evt).digest('hex');
    console.log('  valid signature verifies:', verifyWebhook(m.webhookSecret,ts,evt,goodSig));
    const badSig=crypto.createHmac('sha256','wrong').update(ts+'.'+evt).digest('hex');
    console.log('  forged signature rejected:', !verifyWebhook(m.webhookSecret,ts,evt,badSig));

    console.log('\n--- 5. R (stealth ephemeral key) stayed server-side, never returned to payer ---');
    console.log('  payment response had no R field:', !('R' in cr) && !('r' in cr));

    console.log('\nAll flows exercised. Shutting down.');
    server.close();
  });
}

module.exports = { deriveDeposit, sendWebhook, verifyWebhook };
