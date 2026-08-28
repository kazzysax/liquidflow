import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { base, mainnet, polygon } from 'viem/chains';
import { encodeFunctionData, erc20Abi, formatUnits, isAddress, parseUnits } from 'viem';

const NETWORKS = {
  'eip155:1': { name: 'Ethereum', chainId: 1 },
  'eip155:137': { name: 'Polygon', chainId: 137 },
  'eip155:8453': { name: 'Base', chainId: 8453 },
};

function short(address) {
  return address ? `${address.slice(0, 10)}…${address.slice(-6)}` : '—';
}

function WalletPanel() {
  const { ready, authenticated, user, login, logout, sendTransaction } = usePrivy();
  const [profile, setProfile] = useState(window.LiquidFlowMerchant || null);
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const receive = event => setProfile(event.detail || null);
    window.addEventListener('liquidflow:merchant', receive);
    return () => window.removeEventListener('liquidflow:merchant', receive);
  }, []);

  const refresh = useCallback(async () => {
    if (!profile?.apiKey) return;
    setLoading(true);
    try {
      const response = await fetch('/api/merchants?view=portfolio', {
        headers: { Authorization: `Bearer ${profile.apiKey}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Portfolio refresh failed');
      setPortfolio(data);
    } catch (error) {
      setMessage(error.message || 'Portfolio refresh failed');
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const executeDex = async event => {
      const { plan, address } = event.detail || {};
      if (!plan?.steps?.length || !address) return;
      if (!authenticated || user?.id !== profile?.privyUserId) {
        window.dispatchEvent(new CustomEvent('liquidflow:dex-result', { detail: { status: 'error', message: 'Sign in with the registered merchant Privy account first.' } }));
        return;
      }
      if (address.toLowerCase() !== profile.settlement.primary_wallet.toLowerCase()) {
        window.dispatchEvent(new CustomEvent('liquidflow:dex-result', { detail: { status: 'error', message: 'Swap must use the merchant primary wallet.' } }));
        return;
      }
      try {
        for (let index = 0; index < plan.steps.length; index += 1) {
          const step = plan.steps[index];
          window.dispatchEvent(new CustomEvent('liquidflow:dex-result', { detail: { status: 'progress', message: `Approval ${index + 1} of ${plan.steps.length}: ${step.label}` } }));
          await sendTransaction(
            { to: step.to, data: step.data, value: BigInt(step.value || '0'), chainId: plan.chain_id },
            { address },
          );
        }
        window.dispatchEvent(new CustomEvent('liquidflow:dex-result', { detail: { status: 'success' } }));
        window.setTimeout(refresh, 8000);
      } catch (error) {
        window.dispatchEvent(new CustomEvent('liquidflow:dex-result', { detail: { status: 'error', message: error?.message || 'Swap was not approved.' } }));
      }
    };
    window.addEventListener('liquidflow:dex-execute', executeDex);
    return () => window.removeEventListener('liquidflow:dex-execute', executeDex);
  }, [authenticated, user, profile, refresh, sendTransaction]);

  const holdings = useMemo(
    () => (portfolio?.holdings || []).filter(item => BigInt(item.amount_base || '0') > 0n),
    [portfolio],
  );
  useEffect(() => {
    if (!selected && holdings.length) {
      const first = holdings[0];
      setSelected(`${first.address}:${first.chain}:${first.asset}`);
    }
  }, [holdings, selected]);

  if (!profile) return <div className="wallet-muted">Open the merchant dashboard to load wallet controls.</div>;
  if (profile.settlement?.provider !== 'PRIVY') {
    return <div className="wallet-muted">This legacy gateway keeps its original merchant-controlled settlement flow.</div>;
  }

  const identityMatches = authenticated && user?.id === profile.privyUserId;
  const chosen = holdings.find(item => `${item.address}:${item.chain}:${item.asset}` === selected);

  async function transfer() {
    setMessage('');
    if (!identityMatches) return setMessage('Sign in with the registered merchant email first.');
    if (!chosen) return setMessage('Choose a funded asset.');
    if (!isAddress(recipient)) return setMessage('Enter a valid EVM destination address.');
    let value;
    try {
      value = parseUnits(String(amount).trim(), chosen.decimals);
      if (value <= 0n || value > BigInt(chosen.amount_base)) throw new Error();
    } catch {
      return setMessage('Enter an amount greater than zero and no more than the available balance.');
    }
    try {
      setMessage('Waiting for your approval in Privy…');
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, value],
      });
      const result = await sendTransaction(
        { to: chosen.contract, data, chainId: NETWORKS[chosen.chain].chainId },
        { address: chosen.address },
      );
      setMessage(`Submitted: ${result.hash}`);
      setAmount('');
      window.setTimeout(refresh, 8000);
    } catch (error) {
      setMessage(error?.message || 'Transfer was not approved.');
    }
  }

  return <div className="wallet-console">
    <div className="wallet-console-head">
      <div>
        <h3>Available wallet balances</h3>
        <p>Every customer payment settles directly in this primary wallet.</p>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh balances'}</button>
    </div>

    <div className="wallet-balances">
      {(portfolio?.balances || []).map(item => <div className="wallet-balance" key={`${item.chain}:${item.asset}`}>
        <span>{item.asset} · {NETWORKS[item.chain]?.name || item.chain}</span>
        <strong>{formatUnits(BigInt(item.amount_base || '0'), item.decimals)}</strong>
      </div>)}
      {!loading && !(portfolio?.balances || []).length && <div className="wallet-muted">No supported balances found yet.</div>}
    </div>

    <div className="wallet-gas-grid">
      {(portfolio?.gas_balances || []).map(item => <div className={'wallet-gas ' + (item.ready ? 'ready' : 'needs-gas')} key={item.chain}>
        <span>{NETWORKS[item.chain]?.name} gas</span>
        <strong>{formatUnits(BigInt(item.amount_base || '0'), item.decimals)} {item.symbol}</strong>
        <small>{item.ready ? 'Ready for withdrawal' : 'Add ' + item.symbol + ' for gas'}</small>
      </div>)}
    </div>

    {!ready ? <div className="wallet-muted">Preparing secure merchant login…</div> : !authenticated ?
      <div className="wallet-auth">
        <p>Sign in with <strong>{profile.email}</strong> to manage these wallets.</p>
        <button className="btn" onClick={() => login({ loginMethods: ['email'] })}>Sign in with Privy</button>
      </div> : !identityMatches ?
      <div className="wallet-auth wallet-warning">
        <p>This Privy account does not own this merchant gateway.</p>
        <button className="btn btn-ghost" onClick={logout}>Use the registered account</button>
      </div> :
      <div className="wallet-transfer">
        <div className="wallet-verified">✓ Merchant identity verified · {short(profile.settlement.primary_wallet)}</div>
        {holdings.length ? <>
          <label>Asset to withdraw</label>
          <select className="lf-input" value={selected} onChange={event => setSelected(event.target.value)}>
            {holdings.map(item => <option key={item.address + ':' + item.chain + ':' + item.asset} value={item.address + ':' + item.chain + ':' + item.asset}>
              {item.asset} on {NETWORKS[item.chain]?.name} · {formatUnits(BigInt(item.amount_base), item.decimals)}
            </option>)}
          </select>
          <div className="wallet-transfer-grid">
            <div><label>Send to</label><input className="lf-input mono" value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="0x…" /></div>
            <div><label>Amount</label><input className="lf-input" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /></div>
          </div>
          <button className="btn" onClick={transfer}>Review withdrawal</button>
        </> : <>
          <div className="wallet-muted">The primary wallet has no supported token balance yet.</div>
          <button className="btn" disabled>Withdraw</button>
        </>}
        <div className="wallet-gas-note">Withdrawals and DEX swaps require ETH on Ethereum/Base or POL on Polygon in this primary wallet. The gas indicators above show when each network is ready.</div>
        <button className="wallet-signout" onClick={logout}>Sign out of Privy</button>
      </div>}
    {message && <div className="wallet-message">{message}</div>}
  </div>;
}

async function boot() {
  const target = document.getElementById('privyWalletApp');
  if (!target) return;
  try {
    createRoot(target).render(
      <PrivyProvider appId="cmt9nicuv01zk0dl1eog8bsvx" config={{
        loginMethods: ['email'],
        defaultChain: mainnet,
        supportedChains: [mainnet, polygon, base],
        appearance: { theme: 'light', accentColor: '#5B48F5' },
      }}>
        <WalletPanel />
      </PrivyProvider>,
    );
  } catch (error) {
    target.innerHTML = `<div class="wallet-muted">${error.message || 'Merchant wallet login is unavailable.'}</div>`;
  }
}

boot();