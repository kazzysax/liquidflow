// GET /api/cron/watch — Vercel Cron backstop.
// Scans all pending payments, checks each deposit address on-chain, and confirms
// (firing webhooks) when funded. Frontend polling also confirms on-demand via
// _lib/chain.checkAndConfirm, so this is mainly a safety net.
const store = require('../_lib/store');
const { checkAndConfirm } = require('../_lib/chain');
const { releaseDue } = require('../_lib/payroll');

module.exports = async function handler(req, res) {
  // Vercel Cron sends GET; protect against random callers in production.
  // Fail closed: if CRON_SECRET is not configured, reject everything rather than
  // accept "Bearer undefined" (a template-string footgun that would let any caller in).
  if (process.env.VERCEL_ENV === 'production') {
    const secret = process.env.CRON_SECRET;
    const auth   = req.headers['authorization'] || '';
    if (!secret || auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  let confirmed = 0, expired = 0, errors = 0;

  // 1) Confirm pending deposits
  const pendingIds = await store.smembers('payments:pending');
  await Promise.allSettled(pendingIds.map(async (id) => {
    try {
      const payment = await store.get(`payment:${id}`);
      if (!payment || payment.status !== 'awaiting_payment') {
        await store.srem('payments:pending', id);
        return;
      }
      await checkAndConfirm(payment);
      if (payment.status === 'confirmed') confirmed++;
      else if (payment.status === 'expired') expired++;
    } catch (e) {
      console.error(`[watch] error processing ${id}:`, e.message);
      errors++;
    }
  }));

  // 2) Payroll keeper — release any due, company-defined payouts (trigger only).
  let payouts_released = 0;
  const payrolls = await store.smembers('payrolls:all');
  await Promise.allSettled(payrolls.map(async (addr) => {
    try {
      const meta = await store.get(`payroll:${addr}`);
      payouts_released += (await releaseDue(addr, meta)).length;
    } catch (e) { console.error(`[watch] payroll ${addr}:`, e.message); }
  }));

  return res.status(200).json({ checked: pendingIds.length, confirmed, expired, errors, payrolls: payrolls.length, payouts_released });
};
