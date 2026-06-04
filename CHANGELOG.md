# Changelog — contracts

All notable changes to the **contracts** workspace are documented here.

This file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
Conventional Commits scoped to `contracts` (or `contracts/*`). Do not
hand-edit entries below the baseline — only the baseline section is
curated.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on storage layout:** any change scoped `contracts/diamond` that
> reorders or removes storage slots is a `BREAKING CHANGE` and bumps
> the major version. See
> `docs/architecture/50-storage-slot-registry.md`.

## [0.1.0] — 2026-05-12

Baseline entry summarizing the current shipped state of the contracts
workspace at the time Conventional Commits + release-please were adopted.

### Features
- GSDC ERC-20 token with EIP-3009 (transfer-with-authorization) extension.
- Settlement Diamond (EIP-2535) with append-only storage slot registry.
- Margin Wallet contracts.
- Hardhat tooling: compile, test, coverage (`solidity-coverage`),
  `solhint` linting.
- Sepolia deploy scripts: `deploy-token.ts`, `deploy-diamond.ts`,
  `deploy-margin-wallets.ts`.
- Etherscan verification (`verify-on-etherscan.ts`) and ABI export
  (`export-abi.ts`).
- Local dev fixture (`scripts/dev-fixture.ts`).

### Security
- OpenZeppelin contracts v5.
- Diamond storage layout reviewed against the storage slot registry.
