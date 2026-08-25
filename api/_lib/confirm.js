// Shared payment-confirmation logic used by the deposit-watcher and the
// test simulate endpoint. Works for merchant payments AND fundraiser donations.
const store   = require('./store');
const webhook = require('./webhook');
const { trackVerseEvent } = require('./verse-analytics');

async function confirmPayment(payment, confirmations) {
  // Distributed concurrency guard: on-demand polling and the cron watcher can run
  // on different serverless instances. A re-read alone is not atomic; both callers
  // can observe "awaiting" before either writes. Only the lock winner may transition
  // state or emit a webhook. The short TTL permits recovery if a process dies mid-call.
  const acquired = await store.setIfAbsent(`lock:confirm:${payment.id}`, Date.now(), 30);
  if (!acquired) {
    const latest = await store.get(`payment:${payment.id}`);
    if (latest) Object.assign(payment, latest);
    return false;
  }

  const fresh = await store.get(`payment:${payment.id}`);
  if (fresh && fresh.status && !['awaiting_payment', 'awaiting_topup', 'checking_finality'].includes(fresh.status)) {
    Object.assign(payment, fresh);
    return false;
  }

  payment.status        = 'confirmed';
  payment.confirmedAt   = Date.now();
  payment.confirmations = confirmations;
  await store.set(`payment:${payment.id}`, payment);
  await store.srem('payments:pending', payment.id);

  await trackVerseEvent('Payment Confirmed', {
    asset: payment.asset,
    chain: payment.chain,
    privacy_mode: payment.mode,
  });

  let webhookSent = false;
  if (payment.apiKey) {
    const merchant = await store.get(`merchant:${payment.apiKey}`);
    if (merchant && merchant.webhookUrl) {
      await webhook.send(merchant.webhookUrl, merchant.webhookSecret, {
        type:          'payment.confirmed',
        payment_id:    payment.id,
        amount:        payment.amount,
        asset:         payment.asset,
        chain:         payment.chain,
        confirmations,
        final:         true,
      });
      webhookSent = true;
    }
  }
  return webhookSent;
}

module.exports = { confirmPayment };
