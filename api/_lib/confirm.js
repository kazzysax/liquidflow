// Shared payment-confirmation logic used by the deposit-watcher and the
// test simulate endpoint. Works for merchant payments AND fundraiser donations.
const store   = require('./store');
const webhook = require('./webhook');

async function confirmPayment(payment, confirmations) {
  // Concurrency guard: on-demand polling (listing / checkout) and the cron watcher
  // can race to confirm the same payment. Re-read the authoritative record and bail
  // if it is no longer awaiting — otherwise a payment.confirmed webhook fires twice.
  const fresh = await store.get(`payment:${payment.id}`);
  if (fresh && fresh.status && fresh.status !== 'awaiting_payment') {
    Object.assign(payment, fresh);
    return false;
  }

  payment.status        = 'confirmed';
  payment.confirmedAt   = Date.now();
  payment.confirmations = confirmations;
  await store.set(`payment:${payment.id}`, payment);
  await store.srem('payments:pending', payment.id);

  // Onboarding fee → activate the merchant's gateway (their API key now works).
  if (payment.onboarding && payment.apiKey) {
    const m = await store.get(`merchant:${payment.apiKey}`);
    if (m && m.status !== 'active') {
      m.status = 'active';
      m.activatedAt = Date.now();
      await store.set(`merchant:${payment.apiKey}`, m);
    }
    if (m && m.webhookUrl) {
      await webhook.send(m.webhookUrl, m.webhookSecret, {
        type:          'merchant.activated',
        merchant_id:   m.id,
        payment_id:    payment.id,
        amount:        payment.amount,
        asset:         payment.asset,
        chain:         payment.chain,
        confirmations,
        final:         true,
      });
      return true;
    }
    return false;
  }

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
