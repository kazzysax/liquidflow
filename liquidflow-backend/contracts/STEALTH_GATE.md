# Stealth Deposit Gate — program-based private deposits (non-EVM)

## Why this exists

EVM stealth (EIP-5564, `api/_lib/crypto.js`) is sound because an Ethereum private key
is a raw scalar, so the one-time key `p = k_spend + s` can sign directly. **ed25519
(Solana/Sui) breaks this**: a wallet key is a 32-byte *seed* that is hashed and clamped
into the signing scalar, so a stealth-derived scalar has no importable seed and funds
sent there are unspendable with standard tooling → fund loss.

Rather than ship a fragile custom ed25519 raw-scalar signer (nonce-reuse = instant key
leak), we get private, non-custodial deposits from an **on-chain program** — the same
trust model as the EVM `PaymentGate.sol`:

- **Spendability** is enforced by the program signing a vault PDA/object, not by anyone
  reconstructing a private key. Nothing can be unspendable.
- **Privacy** comes from a fresh, program-derived deposit address per payment that
  outsiders can't enumerate (seeded by the merchant gate + the random `paymentId`).
- **Non-custodial**: only the merchant's own authority can sweep; Liquid Flow has no
  fund-moving instruction and only watches the vault balance to confirm.

## Status

| Chain  | Artifact                                             | State |
|--------|------------------------------------------------------|-------|
| Solana | `solana/programs/stealth_gate` (Anchor)              | Review-grade draft — **not compiled here**; needs `anchor build/test` + Phase-5 audit |
| Sui    | `sui/sources/stealth_gate.move`                      | **Planned next** — same model in Move's object form (design below) |

Neither may touch mainnet until GO-LIVE Phase 5 (contract audit + crypto audit) clears.
On Solana, the deployed **program upgrade authority must be burned or multisig-held,
never Liquid Flow's** — it's the only real backdoor.

## Solana model (built)

1. `init_gate(authority)` → creates `Gate` PDA `["gate", authority]` storing the
   merchant's own Solana pubkey. One gate per merchant.
2. Deposit address for a payment = vault PDA `["vault", gate, paymentId]`. The API
   derives it off-chain and shows it to the payer; the payer sends SOL to it directly
   (no instruction needed). Deposits must exceed the rent-exempt minimum (~0.00089 SOL),
   which any real payment does.
3. `sweep(paymentId)` → signed by the merchant `authority`, moves the vault's full
   balance to a merchant-chosen `destination` via `invoke_signed`. Use a fresh
   destination per sweep to keep settlement unlinkable.

### Off-chain address derivation (for the API + watcher)

```js
const { PublicKey } = require('@solana/web3.js');
const PROGRAM_ID = new PublicKey('Liqu1dF1owStea1thGate1111111111111111111111');
const [gate]  = PublicKey.findProgramAddressSync(
  [Buffer.from('gate'), merchantAuthority.toBuffer()], PROGRAM_ID);
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), gate.toBuffer(), Buffer.from(paymentId)], PROGRAM_ID);
// `vault` is the deposit address; the watcher confirms when its balance >= amount
// (fresh single-use address, so the absolute check is sound — same as EVM stealth).
```

Wiring: replace `ed.solanaAddress(...)` in `api/payments/index.js` / `api/fundraisers/[id].js`
with this PDA derivation, and add a `sweep`-builder to the merchant tooling. Keep
`ENABLE_ED25519_STEALTH` **off** — this program replaces that path, it doesn't revive it.

## Privacy tradeoff (be honest with users)

This is **pseudonymous with merchant-controlled unlinkability**, slightly weaker than
true EIP-5564 stealth:

- Deposit addresses are program-derived PDAs — an observer can tell they belong to
  *this program*, though not which merchant (seeds are unguessable). ✅ unlinkable at deposit.
- The sweep forwards vault → destination. If the merchant reuses one payout address,
  deposits become linkable to that address. **Mitigation: sweep to a fresh destination
  per payment** (the tooling should default to this). With that, on-chain observers see
  only PDA → fresh-address, revealing no merchant identity.

If you need deposit addresses that are indistinguishable from ordinary wallets (full
EIP-5564 anonymity set), that requires the audited raw-scalar ed25519 signer path — a
separate, higher-risk workstream.

## Sui model (planned next — same guarantees, Move object form)

- A shared `Gate` object holds the merchant `authority` address.
- Per payment, create a `DepositTicket` object (id derived from gate + paymentId) that
  holds a `Balance<SUI>`; the payer funds it. Only a `sweep` entry function checked
  against `ctx.sender == gate.authority` can extract the balance to a chosen address.
- Same non-custodial + spendable-by-construction properties; same Phase-5 gate. The
  package **UpgradeCap** must be burned or multisig-held, never Liquid Flow's.
