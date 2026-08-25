// Non-custodial mainnet liquidity router for LiquidFlow merchants.
// The server only reads pools and builds allowlisted calldata. The merchant's
// browser wallet signs the exact approval and swap; LiquidFlow never holds a key.
const { ethers } = require('ethers');
const { rpcUrl, isValidBaseAmount } = require('./chain');

const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_SLIPPAGE_BPS = 300;
const MAX_PRICE_IMPACT_BPS = 500;
const MAX_RESERVE_SHARE_BPS = 1000;
const DEADLINE_SECONDS = 10 * 60;

const ROUTES = Object.freeze({
  'eip155:1': Object.freeze({
    chainId: 1,
    provider: 'Verse DEX',
    role: 'primary',
    router: '0xB4B0ea46Fe0E9e8EAB4aFb765b527739F2718671',
    factory: '0xee3E9E46E34a27dC755a63e2849C9913Ee1A06E2',
    wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    intermediates: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    tokens: Object.freeze({
      VERSE: Object.freeze({ symbol: 'VERSE', address: '0x249ca82617ec3dfb2589c4c17ab7ec9765350a18', decimals: 18 }),
      USDC: Object.freeze({ symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }),
    }),
  }),
  'eip155:137': Object.freeze({
    chainId: 137,
    provider: 'QuickSwap',
    role: 'liquidity_fallback',
    router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
    factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
    wrapped: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    intermediates: [
      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
      '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    ],
    tokens: Object.freeze({
      FXVERSE: Object.freeze({ symbol: 'fxVERSE', address: '0xc708D6F2153933DAA50B2D0758955Be0A93A8FEc', decimals: 18 }),
      USDC: Object.freeze({ symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 }),
    }),
  }),
});

const routerInterface = new ethers.Interface([
  'function factory() view returns (address)',
  'function FACTORY() view returns (address)',
  'function WETH() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)',
]);
const factoryInterface = new ethers.Interface(['function getPair(address,address) view returns (address)']);
const pairInterface = new ethers.Interface([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
]);
const erc20Interface = new ethers.Interface([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
]);

function config(chain) { return ROUTES[String(chain || '')] || null; }
function token(cfg, symbol) { return cfg && cfg.tokens[String(symbol || '').toUpperCase()] || null; }

function validate({ chain, from, to, amount, recipient, slippageBps, slippage_bps }) {
  const cfg = config(chain);
  if (!cfg) throw new Error('DEX routes support Ethereum and Polygon mainnet only');
  const input = token(cfg, from), output = token(cfg, to);
  if (!input || !output) throw new Error(`unsupported ${cfg.provider} token pair`);
  if (input.address.toLowerCase() === output.address.toLowerCase()) throw new Error('from and to must differ');
  if (!isValidBaseAmount(amount)) throw new Error('amount must be a positive integer in source-token base units');
  if (!ethers.isAddress(String(recipient || ''))) throw new Error('recipient must be a valid 0x address');
  const rawBps = slippage_bps == null ? slippageBps : slippage_bps;
  const bps = rawBps == null ? DEFAULT_SLIPPAGE_BPS : Number(rawBps);
  if (!Number.isInteger(bps) || bps < 10 || bps > MAX_SLIPPAGE_BPS) throw new Error(`slippage_bps must be an integer from 10 to ${MAX_SLIPPAGE_BPS}`);
  return { cfg, input, output, amountIn: BigInt(amount), recipient: ethers.getAddress(recipient), bps };
}

function candidatePaths(cfg, input, output) {
  const direct = [input.address, output.address];
  const via = cfg.intermediates
    .filter(x => x.toLowerCase() !== input.address.toLowerCase() && x.toLowerCase() !== output.address.toLowerCase())
    .map(x => [input.address, x, output.address]);
  return [direct, ...via];
}

async function assertContracts(cfg, provider) {
  const [routerCode, factoryCode] = await Promise.all([provider.getCode(cfg.router), provider.getCode(cfg.factory)]);
  if (routerCode === '0x' || factoryCode === '0x') throw new Error('approved DEX contracts are not deployed on this chain');
  const router = new ethers.Contract(cfg.router, routerInterface.fragments, provider);
  const factoryRead = cfg.provider === 'Verse DEX' ? router.FACTORY() : router.factory();
  const [factory, wrapped] = await Promise.all([factoryRead, router.WETH()]);
  if (factory.toLowerCase() !== cfg.factory.toLowerCase() || wrapped.toLowerCase() !== cfg.wrapped.toLowerCase()) throw new Error('DEX router identity check failed');
}

async function inspectPath(cfg, path, amounts, provider) {
  const factory = new ethers.Contract(cfg.factory, factoryInterface.fragments, provider);
  const pools = [];
  let totalImpact = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const pairAddress = await factory.getPair(path[i], path[i + 1]);
    if (!ethers.isAddress(pairAddress) || pairAddress === ethers.ZeroAddress) throw new Error('route contains a missing pool');
    const pair = new ethers.Contract(pairAddress, pairInterface.fragments, provider);
    const [token0, reserves] = await Promise.all([pair.token0(), pair.getReserves()]);
    const normal = token0.toLowerCase() === path[i].toLowerCase();
    const reserveIn = BigInt(normal ? reserves[0] : reserves[1]);
    const reserveOut = BigInt(normal ? reserves[1] : reserves[0]);
    const hopIn = BigInt(amounts[i]), hopOut = BigInt(amounts[i + 1]);
    if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('route contains an empty pool');
    const reserveShareBps = Number(hopIn * 10000n / reserveIn);
    if (reserveShareBps > MAX_RESERVE_SHARE_BPS) throw new Error('trade exceeds the maximum safe share of pool reserves');
    const idealOut = hopIn * reserveOut / reserveIn;
    const impact = idealOut > hopOut ? Number((idealOut - hopOut) * 10000n / idealOut) : 0;
    totalImpact += impact;
    pools.push({ pair: pairAddress, input_reserve: reserveIn.toString(), output_reserve: reserveOut.toString(), price_impact_bps: impact });
  }
  if (totalImpact > MAX_PRICE_IMPACT_BPS) throw new Error(`price impact ${totalImpact} bps exceeds the ${MAX_PRICE_IMPACT_BPS} bps safety limit`);
  return { pools, priceImpactBps: totalImpact };
}

function buildPlan({ cfg, input, output, amountIn, amountOut, path, recipient, bps, deadline, blockNumber, pools, priceImpactBps, allowance = 0n }) {
  const minOut = amountOut * BigInt(10000 - bps) / 10000n;
  if (minOut <= 0n) throw new Error('quoted output is too small after slippage protection');
  const expires = deadline || Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const steps = [];
  if (allowance < amountIn) {
    if (allowance > 0n) steps.push({ label: 'reset approval', to: input.address, data: erc20Interface.encodeFunctionData('approve', [cfg.router, 0n]), value: '0' });
    steps.push({ label: `approve exact ${input.symbol}`, to: input.address, data: erc20Interface.encodeFunctionData('approve', [cfg.router, amountIn]), value: '0' });
  }
  steps.push({ label: `swap ${input.symbol} to ${output.symbol}`, to: cfg.router, data: routerInterface.encodeFunctionData('swapExactTokensForTokens', [amountIn, minOut, path, recipient, expires]), value: '0' });
  return {
    provider: cfg.provider,
    provider_role: cfg.role,
    chain: Object.keys(ROUTES).find(k => ROUTES[k] === cfg),
    chain_id: cfg.chainId,
    router: cfg.router,
    factory: cfg.factory,
    input: { ...input, amount: amountIn.toString() },
    output: { ...output, quoted_amount: amountOut.toString(), minimum_amount: minOut.toString() },
    slippage_bps: bps,
    price_impact_bps: priceImpactBps,
    deadline: expires,
    quote_block: String(blockNumber),
    path,
    pools,
    steps,
    note: cfg.role === 'liquidity_fallback'
      ? 'Merchant-signed Polygon liquidity fallback. QuickSwap is used only where an official Verse DEX router cannot provide the required Polygon route. Contracts and tokens are allowlisted, approval is exact, pool impact is capped, and calldata expires after ten minutes.'
      : 'Merchant-signed mainnet swap through the official Verse DEX router. Contracts and tokens are allowlisted, approval is exact, pool impact is capped, and calldata expires after ten minutes.',
  };
}

async function quote(params, providerOverride) {
  const checked = validate(params);
  const provider = providerOverride || new ethers.JsonRpcProvider(rpcUrl(String(params.chain)));
  const blockNumber = await provider.getBlockNumber();
  await assertContracts(checked.cfg, provider);
  const router = new ethers.Contract(checked.cfg.router, routerInterface.fragments, provider);
  // Read candidates sequentially. Some production RPC providers throttle the
  // short burst of calls needed to inspect several pools in parallel.
  const candidates = [];
  for (const path of candidatePaths(checked.cfg, checked.input, checked.output)) {
    try {
      const amounts = await router.getAmountsOut(checked.amountIn, path);
      const inspected = await inspectPath(checked.cfg, path, amounts, provider);
      candidates.push({ path, amounts, amountOut: BigInt(amounts[amounts.length - 1]), ...inspected });
    } catch { /* Try the next allowlisted path. */ }
  }
  const best = candidates.filter(Boolean).sort((a, b) => a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0)[0];
  if (!best || best.amountOut <= 0n) throw new Error('no safe live DEX route is available for this amount');
  const inputToken = new ethers.Contract(checked.input.address, erc20Interface.fragments, provider);
  const allowance = BigInt(await inputToken.allowance(checked.recipient, checked.cfg.router));
  return buildPlan({ ...checked, ...best, allowance, blockNumber });
}

module.exports = { ROUTES, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, MAX_PRICE_IMPACT_BPS, MAX_RESERVE_SHARE_BPS, DEADLINE_SECONDS, config, token, validate, candidatePaths, buildPlan, quote };
