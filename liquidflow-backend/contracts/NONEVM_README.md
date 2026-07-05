# Liquid Flow — Non-EVM Platform Wallet Contracts

Native implementations of the builder-owned, non-custodial platform wallet on
**Solana, Aptos, Sui, and NEAR**, each enforcing the full shared guarantee set
(G1–G11) from `../docs/multichain-wallet-design.md`.

The EVM version (`../src/PlatformWallet.sol`, `../src/SecurePlatformWallet.sol`)
is compiled and EVM-verified. These four are **review-grade**: written to build
under the pinned toolchains, but NOT compiled in the authoring sandbox because
those toolchains (Solana CLI, Aptos/Sui CLIs, NEAR cargo targets) are
network-restricted there. Build and test locally with the commands below.

## What each enforces (G1–G11)

Builder owns it · 2-of-N quorum to move funds · Liquid Flow can never move funds ·
builder can sweep out · withdrawal allowlist · allowlist time-delay (guardian can
cancel) · time-lock on large withdrawals · rolling 24h velocity cap · circuit
breaker (instant pause, quorum unpause) · guardian (pause/cancel only, never moves
funds) · no replay / no double-approve.

## Per-chain layout, build & test

### Solana (Anchor)
```
solana/programs/platform_wallet/src/lib.rs
solana/programs/platform_wallet/Cargo.toml
```
```bash
# prerequisites: rustup, solana-cli, anchor-cli
cd solana
anchor build
anchor test          # runs against a local validator
```

### Aptos (Move)
```
aptos/sources/platform_wallet.move
aptos/Move.toml
```
```bash
# prerequisites: aptos CLI
cd aptos
aptos move compile --named-addresses liquidflow=default
aptos move test
```

### Sui (Move, object model)
```
sui/sources/platform_wallet.move
sui/Move.toml
```
```bash
# prerequisites: sui CLI
cd sui
sui move build
sui move test
```

### NEAR (Rust → WASM)
```
near/src/lib.rs
near/Cargo.toml
```
```bash
# prerequisites: rustup + wasm32 target, cargo-near
cd near
cargo test                       # unit tests
cargo near build                 # produce the wasm artifact
```

## CRITICAL post-deploy security step (every chain)

The biggest non-custodial risk on non-EVM chains is the **upgrade/redeploy
authority**, which can replace the contract logic entirely:

- **Solana:** set the program **upgrade authority** to a builder/guardian multisig
  or burn it. Never Liquid Flow.
- **Aptos:** publish under an immutable or multisig-controlled **package upgrade
  policy**.
- **Sui:** burn the **UpgradeCap** or hold it under a builder/guardian multisig.
- **NEAR:** remove the contract account's **full-access keys** (lock the account)
  or place them under a multisig.

If Liquid Flow held any of these, the non-custodial guarantee would be void
regardless of the instruction logic. This step is as important as the code.

## Verification status (honest)

- **EVM:** compiled (solc 0.8.28) + executed against a real EVM. 12/12 base +
  15/15 security tests pass.
- **Solana / Aptos / Sui / NEAR:** review-grade, NOT sandbox-compiled (toolchains
  network-blocked here). Build/test locally with the commands above.
- The two earlier review flags are **resolved**: Solana now holds SOL in a
  dedicated system-owned vault PDA and withdraws via a signed `system_program`
  CPI (no borrow conflict); Aptos `execute` is restructured into clean
  read → mutate → extract phases (no overlapping borrows).
- All chains: independent audit + formal verification required before mainnet.
  Nothing here is claimed "verified" that wasn't actually run.

## Parity test checklist (run on each chain before "done")

For each chain, the local test suite should assert:
1. LF / non-owner cannot propose or move funds
2. one owner alone cannot reach quorum
3. quorum moves funds to an allowlisted destination
4. withdrawal to a non-allowlisted destination is rejected
5. new allowlist entry cannot activate before its delay; guardian can cancel it
6. large withdrawal is time-locked; executes only after the delay
7. withdrawal exceeding the 24h velocity cap is rejected; succeeds after reset
8. paused state blocks withdrawals; unpause requires quorum
9. no replay (re-execute fails); no double-approve by one owner
