module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  if (!process.env.PRIVY_APP_ID) return res.status(503).json({ error: 'merchant wallet login is not configured' });
  return res.status(200).json({ privy_app_id: process.env.PRIVY_APP_ID });
};