# Liquid Flow — Potlock (Private Fundraising) Design

**Status:** design · companion to the Integrate Payment spec.
**Goal:** crowdfunding where DONORS are unlinkable on-chain (stealth addresses),
while the campaign's TOTAL raised is public (progress curve). Works across EVM +
Solana + Aptos + Sui + NEAR. Each campaign can "unify liquidity" or "leave as
sent." Non-custodial throughout.

---

## 1. The privacy goal, stated precisely

- **Donor unlinkability (who):** an outside observer scanning the chain cannot
  tell that a given payment is a Potlock donation, cannot link multiple donations
  to one campaign, and cannot link multiple donations from the same donor.
  Achieved with **stealth addresses** — every donation lands at a fresh one-time
  address.
- **Public total (how much, in aggregate):** the campaign's running total and
  progression curve ARE public. This is computed from a **view key** the campaign
  shares with the dashboard backend; it does NOT expose individual donor identities
  and CANNOT move funds.
- **What is deliberately NOT private:** the aggregate total. Hiding amounts on-chain
  (ZK confidential transfers) would make a public total impossible, so we don't do
  it. Donors get identity privacy; the campaign gets a public progress number.

**Litmus:** a blockchain explorer shows a scattering of unrelated one-time
addresses, not "Campaign X received N donations." Only the view-key holder can see
the set; only the spend-key holder can move funds.

---

## 2. Stealth address scheme (the mechanism)

Standard dual-key stealth scheme (EVM: ERC-5564 / ERC-6538; same math reused on
other chains with that chain's curve):

1. Campaign creates a **stealth meta-address** = (spend pubkey `P_spend`, view
   pubkey `P_view`). The matching private keys are held by the campaign; the view
   key may be shared with the LF dashboard backend for totalling (view-only).
2. A donor's wallet:
   - generates a random **ephemeral keypair** (`r`, `R = r·G`),
   - computes a shared secret `s = hash(r · P_view)`,
   - derives the **one-time stealth address** from `P_spend + s·G`,
   - sends the donation there, and publishes `R` (the ephemeral pubkey) — either
     on-chain via an announcer, or to the LF backend off-chain.
3. The campaign scans announcements: for each `R`, computes `s = hash(k_view · R)`
   and checks whether `P_spend + s·G` is an address it received funds at. Matches =
   its donations. It can **spend** with `k_spend + s` (only the spend-key holder).

Key properties:
- The view key finds donations but **cannot spend** them → safe to give the
  dashboard backend for live totals while staying non-custodial.
- Each donation address is unlinkable to the campaign or to other donations by
  anyone without the view key.

---

## 3. Per-chain reality (honest: maturity varies)

| Chain | Curve | Stealth status |
|---|---|---|
| EVM (all) | secp256k1 | **Standardized** (ERC-5564 announcer + ERC-6538 registry). Most turnkey. |
| Solana | ed25519 | No community standard; implement custom derivation (ed25519 stealth is doable but bespoke). |
| Aptos | ed25519 | Same as Solana — custom scheme. |
| Sui | ed25519 | Custom scheme. |
| NEAR | ed25519 | Custom scheme. |

**Implication:** "all chains" means LF ships a **consistent stealth scheme we
implement per chain**. EVM uses the public standard; the four ed25519 chains use a
common custom derivation (one design, applied four times). This is real crypto
work and must be audited especially carefully — homemade stealth schemes are
high-risk if rolled by hand. We use well-reviewed primitives and follow the
EIP-5564 structure closely.

---

## 4. "Unify liquidity" vs "leave as sent" (per campaign)

- **Leave as sent (max privacy):** donations rest at their stealth addresses in
  whatever asset/chain they arrived. The campaign sweeps with the spend key when
  ready. No swaps → no added on-chain linkage. **Most private.**
- **Unify liquidity:** as donations arrive, each is swapped to one settlement asset
  (via the campaign's chosen DEX aggregator) and consolidated.
  **HONEST TRADE-OFF:** swapping + consolidating creates on-chain linkage that can
  erode stealth unlinkability (the consolidation step ties addresses together).
  A campaign choosing "unify" trades some donor privacy for liquidity simplicity.
  The UI must state this plainly so the choice is informed. Mitigations: time-
  randomized, batched swaps; per-donation routing; but privacy is still reduced
  vs "leave as sent."

Recommendation surfaced in UI: privacy-max campaigns pick "leave as sent";
operations-simple campaigns pick "unify" knowing the trade.

---

## 5. Public dashboard (what it shows — and only this)

- **Total raised** (from the view-key sum) and a **goal/progress bar**.
- **Progression curve** over time (aggregate only).
- **Donate button** → generates a fresh stealth address per donor and shows it
  (+ QR). Nothing else.
- **NOT shown:** donor addresses, donor identities, per-donation links, anything
  that ties donations together publicly. (Matches the existing
  potlock-fundraiser.html, which already shows only "Anonymous donation + amount";
  this design strengthens that from UI-only privacy to on-chain unlinkability.)

---

## 6. Non-custodial guarantees

- Campaign holds the **spend key** → only the campaign can move donated funds.
- LF may hold the **view key** → can compute totals, CANNOT move funds.
- If unify is on, swaps run via public aggregators contract-to-contract; LF never
  custodies. (Same principle as the platform wallet.)
- Litmus: LF fully compromised → attacker can read the total (already public) but
  cannot move a single donation. Must hold.

---

## 7. Build plan

1. Stealth crypto core (secp256k1 for EVM; ed25519 derivation for non-EVM) with a
   runnable proof that donations are derivable + recognizable + unlinkable.
2. EVM announcer/registry integration (ERC-5564/6538) + a campaign vault the
   spend key controls.
3. Per-chain stealth derivation for Solana/Aptos/Sui/NEAR (custom, shared design).
4. Backend view-key scanner → running total + curve.
5. Public dashboard wired to the total/curve + stealth donate flow.

---

## 8. Honest risks

- **Homemade stealth on non-EVM is the highest-risk crypto in the whole project.**
  Hand-rolled privacy schemes are notoriously easy to get subtly wrong. These need
  dedicated cryptographic review/audit beyond the contract audit.
- **Unify erodes privacy** — documented; surfaced to campaigns.
- **Regulatory:** privacy-preserving money movement attracts AML/sanctions scrutiny
  (mixers have been sanctioned). Stealth addresses are not mixers, but counsel
  review is essential before launch, especially for "unify."
- **View-key handling:** sharing the view key with the backend is convenient but
  means the backend can deanonymize donors internally. Treat the view key as
  sensitive; consider campaign-side totalling if privacy needs are extreme.

---

## 9. Change log
- **v0.1** — initial Potlock privacy design: stealth scheme, per-chain maturity,
  unify-vs-leave trade-off, public-total-only dashboard, non-custodial view/spend
  key split, risks.
