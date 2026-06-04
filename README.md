# GSDC Smart Contracts — Tier B-4

> ⚠️ **Sepolia testnet only. Mainnet promotion requires CertiK audit pass per
> CTO Sign-Off Record (06_GSDC_SignOff_Record.docx). The audit gate is
> non-negotiable.** No mainnet network is defined in `hardhat.config.ts`.

Smart-contract scaffolding for the GSDC settlement orchestrator. Implements
the on-chain layer described in **Sandip's Smart Contract Spec v1**
(`/docs/sandip/05_GSDC_SmartContract_Spec_v1.docx`) and **Build Plan §4.4**
(`/docs/GSDC_Backend_Build_Plan.pdf`).

## Stack

- Solidity `0.8.24` + `evmVersion: cancun` (matches Sepolia post-Mar-2024)
- Hardhat 2.22 + ethers v6
- OpenZeppelin Contracts v5 (ERC-20, EIP-712, ECDSA, ReentrancyGuard, Ownable)
- Reference implementations used **verbatim**:
  - **EIP-2535 Diamond** — Nick Mudge (`Diamond.sol`, `LibDiamond.sol`, `DiamondCutFacet`, `DiamondLoupeFacet`)
  - **EIP-3009 Transfer-with-Authorization** — Circle USDC pattern, OpenZeppelin v5 ECDSA + EIP712

## Layout

```
contracts/
├── GSDCToken.sol                   Sepolia mock GSDC (ERC-20 + EIP-3009 + Ownable)
├── EIP3009Extension.sol            Additive transferWithAuthorization / cancelAuthorization
├── Diamond.sol                     EIP-2535 proxy (Nick Mudge verbatim)
├── DiamondInit.sol                 One-shot Diamond storage initialiser
├── MarginWallet.sol                One-per-partner GSDC accumulator + signed withdrawal
├── facets/
│   ├── DiamondCutFacet.sol         (infra) selector add/replace/remove
│   ├── DiamondLoupeFacet.sol       (infra) introspection — facets / facetAddress / etc.
│   ├── QuoteVerifierFacet.sol      EIP-712 oracle quote verification
│   ├── FloatManagerFacet.sol       per-partner float reservation accounting
│   ├── SettlementExecutorFacet.sol atomic 4-leg settlement (delivery + 3 margins)
│   ├── MarginSplitterFacet.sol     pure bps margin calculation
│   ├── ComplianceGateFacet.sol     partner KYC + corridor authorisation
│   ├── TimeLockControllerFacet.sol time-locked corridor + margin parameter changes
│   ├── DisputeResolverFacet.sol    dispute scaffolding (refund logic in B-12)
│   ├── EventEmitterFacet.sol       centralised event surface for indexers
│   └── MintBurnAuthorityFacet.sol  admin-gated GSDC mint/burn
├── libraries/
│   ├── LibDiamond.sol              EIP-2535 standard storage + diamondCut helpers
│   ├── LibSettlement.sol           Diamond storage struct (slot keccak("gsdc.settlement.storage.v1"))
│   └── LibFloat.sol                pure float arithmetic helpers
└── interfaces/
    ├── IEIP3009.sol
    ├── IDiamondCut.sol             Nick Mudge
    ├── IDiamondLoupe.sol           Nick Mudge
    └── ISettlementDiamond.sol      aggregated external surface (B-5 DiamondClient consumes this ABI)

scripts/
├── deploy-token.ts                 deploys GSDCToken
├── deploy-diamond.ts               deploys cut facet + Diamond + 9 domain facets + DiamondInit
├── deploy-margin-wallets.ts        deploys per-partner MarginWallets
├── verify-on-etherscan.ts          post-deploy Etherscan verification
└── export-abi.ts                   copies compiled ABIs → /app/backend/src/chain/abi/

test/
├── helpers.ts                      shared deployFullDiamond fixture
├── EIP3009.test.ts                 6 cases — happy + replay + window + signer + cancel
├── Diamond.test.ts                 4 cases — cut + loupe + ownership + unknown selector
├── MarginWallet.test.ts            6 cases — owner-only + zero guards + balance
├── E2E.test.ts                     end-to-end settlement happy path + revert paths
├── BranchCoverage.test.ts          targeted branch tests (QuoteVerifier sig, window, etc.)
└── facets/                         per-facet happy + failure path tests
```

## Setup

```bash
yarn install
yarn compile
yarn test
yarn coverage
```

`hardhat.config.ts` reads:
- `SEPOLIA_RPC_URL`         Chainstack EU RPC (no default)
- `DEPLOYER_PRIVATE_KEY`    funded Sepolia EOA (no default)
- `ETHERSCAN_API_KEY`       for verify
- `ORACLE_SIGNER_ADDRESS`   for `DiamondInit.init()` (defaults to deployer)
- `TGS_TREASURY_WALLET`     for `DiamondInit.init()` (defaults to deployer)
- `PARTNER_OWNERS`          CSV of partner EOAs for `deploy-margin-wallets.ts`

## Sepolia deploy (sequence)

```bash
# 1. Token first — needed by Diamond + MarginWallets.
yarn deploy:token

# 2. Diamond + DiamondInit + all 9 domain facets + 2 infra facets +
#    TGS treasury margin wallet. Idempotent storage write to
#    deployments/sepolia.json.
yarn deploy:diamond

# 3. Per-partner margin wallets.
PARTNER_OWNERS=0xAbC...,0xDeF... yarn deploy:margin-wallets

# 4. Etherscan verify everything in deployments/sepolia.json.
yarn verify

# 5. Export ABIs into the backend so B-5 DiamondClient can wire up.
yarn export-abi
```

The orchestrator is set as the Diamond admin during `DiamondInit.init()`,
so partner registration / corridor configuration / margin updates / mint /
burn all flow through the orchestrator's signing key.

## Test results (B-4)

```
64 passing (Hardhat in-memory chain)
0 failing

Coverage:
  Statements: 97.17%   (target ≥ 85%) ✓
  Functions:  96.97%   (target — no formal target) ✓
  Lines:      95.87%   (target — no formal target) ✓
  Branches:   68.82%   (target ≥ 80%) — 11pp short, see below

End-to-end Hardhat-node smoke test: ✓
  - GSDCToken deployed
  - Diamond + 11 facets + DiamondInit cut wired
  - 16 ABIs exported to /app/backend/src/chain/abi/
```

### Branch coverage shortfall — explained

The 11 percentage-point gap is concentrated in:

1. **`LibDiamond.sol` (56.52%)** — Nick Mudge reference verbatim. The
   uncovered branches are within the `Replace` / `Remove` cut paths
   (lines 100-170 in particular: replace-with-same-function guard,
   remove-immutable-function guard). These are upgrade-time paths that
   B-4 scaffolding doesn't exercise; `[SPEC]` rule says do not modify
   the reference.
2. **`EIP3009Extension.sol` (31.25%)** — defensive branches inside
   `cancelAuthorization` overlap with `transferWithAuthorization`
   coverage (same OZ ECDSA path). OpenZeppelin v5 `ECDSA.recover`
   pre-empts the `recovered == address(0)` check by reverting with
   `ECDSAInvalidSignature` first; that leaves the explicit
   `InvalidSignature` branch unreachable in practice. Auditor may
   reduce to one error type before mainnet.
3. **`MarginWallet.sol` line 43** — the `if (!ok)` branch from
   `gsdc.transfer` returning false; OZ ERC-20 always returns true on
   success and reverts on failure, so the explicit boolean check is
   defensive and unreachable with the canonical token.
4. **`SettlementExecutorFacet.sol` lines 74, 148** — the
   `c.maxDeliveryAmount != 0 && deliveryAmount > maxDeliveryAmount`
   joint guard's "max=0 means unbounded" branch is structurally tested
   but not on both sides simultaneously inside one corridor config.

The CertiK audit will require these branches addressed (or proven
unreachable) before mainnet promotion regardless. Recorded as
**`[GAP]`** in the iteration summary.

## Tagging convention used in this tier

- **`[SPEC]`** — verbatim from Sandip's spec or Nick Mudge / Circle / OZ reference. Do not modify without Sign-Off Record entry.
- **`[GAP]`** — spec gap filled by scaffolding decision. Examples:
  - ~~`QuoteVerifierFacet._domainSeparator()` — domain separator built inline; B-5 will refactor through OZ EIP712~~ **RESOLVED in B-5**: domain now `GSDCOracle`/`1` matching `OracleClient`. Inline impl retained (OZ EIP712 base caches `address(this)` at facet construction time, which is the facet's address — wrong for Diamond delegatecall semantics where `verifyingContract` must be the Diamond's address).
  - ~~`SettlementExecutorFacet` — accepts pre-verified inputs; cross-facet call to `QuoteVerifierFacet.verifyAndDecodeQuote` and conversion to EIP-3009 `transferWithAuthorization` lands in B-5~~ **RESOLVED in B-5**: cross-facet `staticcall` to `verifyAndDecodeQuote`, mismatched-corridor / mismatched-quoteId reverts, `transferWithAuthorization` redemption when `authorizationSig` is non-empty. A test-only bypass exists when `encodedQuote`/`oracleSignature`/`authorizationSig` are all empty — **the auditor MUST remove the bypass before mainnet**.
  - `TimeLockControllerFacet.configureCorridor` — folded corridor lifecycle into TimeLock facet rather than inventing a "CorridorAdminFacet" outside the spec's 9
  - `TimeLockControllerFacet.setTimeLockDelay` — admin-only for B-4; meta-time-lock deferred to B-6
  - `DisputeResolverFacet` — emits dispute event only; refund logic lands in B-12
- **`[CARRY]`** — extends frontend or earlier-tier semantics. B-4 had none; B-5 carries the dev-fixture pattern + the `.gitignore` structural fix.

## What's NOT in B-4

- Backend integration (B-5: `DiamondClient` + Quote Engine)
- Settlement state machine in the orchestrator (B-6)
- Real DON+DAO oracle wiring (B-11; for now `oracleSigner` is one EOA)
- Mainnet deployment
- Diamond facet replacement post-initial-deploy

## Audit gate (non-negotiable)

Per **`docs/sandip/06_GSDC_SignOff_Record.docx`**: PartnerAdapter v1.2 is
frozen; smart-contract additions or signature changes require Sandip's
explicit approval. The contracts here are scaffolding intended to be
either rebuilt audit-grade by Sandip's smart-contract dev or audited by
CertiK with their findings folded back in. Either path gates mainnet
promotion.
