// The public DEX route shares the authenticated, rate-conscious receipt handler.
// Setting the internal action here keeps direct Vercel filesystem routing secure.
const handler = require('../receipt');

module.exports = async function dexQuoteHandler(req, res) {
  req.query = { ...(req.query || {}), action: 'dex-quote' };
  return handler(req, res);
};