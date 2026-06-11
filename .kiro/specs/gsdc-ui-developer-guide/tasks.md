# Implementation Plan: GSDC UI Developer Guide

## Overview

Create a comprehensive markdown reference document (`docs/GSDC_UI_Developer_Guide.md`) for UI developers integrating with the GSDC Settlement Diamond system. The document is authored section-by-section following the progressive disclosure structure defined in the design, extracting accurate information from the Solidity source contracts. Each task writes a coherent section of the guide, building incrementally toward the complete ~3000-4000 line document.

## Tasks

- [x] 1. Create document scaffold with title, table of contents, and glossary
  - [x] 1.1 Create `docs/GSDC_UI_Developer_Guide.md` with title, auto-linked table of contents for all 28 sections, and the Glossary section defining all terms from the requirements glossary (Diamond, Facet, Settlement_Diamond, GSDC_Token, Orchestrator, Admin, LP_Source, LP_Dest, Corridor, MarginWallet, EIP_3009_Authorization, Oracle_Quote, TimeLock, Settlement_State, Float_Reservation, UI_Developer)
    - Create the `docs/` directory if it does not exist
    - The ToC must use anchor links matching the heading IDs
    - Glossary terms must match the definitions in requirements.md exactly
    - _Requirements: 1.1, 19.1_

- [x] 2. Write Diamond architecture and lifecycle sections
  - [x] 2.1 Write the Diamond Architecture Overview section explaining EIP-2535 single-proxy pattern, delegatecall routing, that all 13 facets are accessed through one address, the aggregated `ISettlementDiamond` ABI, DiamondLoupe introspection functions (`facetAddresses`, `facetFunctionSelectors`, `facetAddress`, `supportsInterface`), and DiamondInit parameters
    - Source files: `contracts/Diamond.sol`, `contracts/DiamondInit.sol`, `contracts/interfaces/IDiamondLoupe.sol`, `contracts/interfaces/ISettlementDiamond.sol`
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [x] 2.2 Write the Settlement Lifecycle section documenting the six sequential steps (corridor config → partner registration → float reservation → oracle quote → EIP-3009 auth → settlement execution), specifying the exact facet and function for each step, and the four settlement states with valid transitions
    - Source files: `contracts/facets/SettlementExecutorFacet.sol`, `contracts/libraries/LibSettlement.sol`
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

  - [x] 2.3 Write the Settlement State Machine section documenting the four states (PENDING=0, EXECUTING=1, SETTLED=2, FAILED=3) and transitions, noting PENDING→EXECUTING→SETTLED is atomic within a single transaction and FAILED is unreachable (removed during CertiK audit)
    - Source files: `contracts/libraries/LibSettlement.sol`, `contracts/facets/SettlementExecutorFacet.sol`
    - _Requirements: 1.3, 2.7_

  - [x] 2.4 Write the Corridor & Window Configuration section documenting corridor config fields, UTC seconds-from-midnight window format, wrap-around window formula, immediate vs time-locked parameter changes, and margin bps semantics
    - Source files: `contracts/libraries/LibSettlement.sol`, `contracts/facets/TimeLockControllerFacet.sol`
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 1.7_

- [x] 3. Write function references for core settlement facets
  - [x] 3.1 Write the SettlementExecutorFacet function reference documenting `executeSettlement` (all 9 parameters with types and semantics), `executeSettlementAggregated` variant, `getSettlement` view function with Settlement struct (13 fields), 97-byte authorizationSig layout, settlementId-as-nonce binding, Orchestrator-only access, status enum, all revert errors, and `SettlementExecuted` event
    - Source file: `contracts/facets/SettlementExecutorFacet.sol`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 3.2 Write the QuoteVerifierFacet function reference documenting `verifyAndDecodeQuote`, `verifyAndDecodeAggregatedQuote`, OracleQuote struct (11 fields), EIP-712 domain separator (name="GSDCOracle", version="1"), both typehashes, `quoteDomainSeparator()` helper, `queueOracleSignerChange`, midRate hashing, and all revert errors
    - Source file: `contracts/facets/QuoteVerifierFacet.sol`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 3.3 Write the FloatManagerFacet function reference documenting `getAvailableFloat`, `reserveFloat`, `releaseFloatReservation`, `getSettlementReservation`, balance calculation logic, revert conditions, and events (`FloatReserved`, `FloatReleased`)
    - Source file: `contracts/facets/FloatManagerFacet.sol`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 4. Write function references for governance and compliance facets
  - [x] 4.1 Write the ComplianceGateFacet function reference documenting `checkCompliance` (check order: suspended → kycHash → corridor), `registerPartner`, `suspendPartner`, `reactivatePartner`, `addPartnerCorridor` with idempotency note, all revert errors, and events
    - Source file: `contracts/facets/ComplianceGateFacet.sol`
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 4.2 Write the TimeLockControllerFacet function reference documenting the queue-execute pattern, `queueMarginUpdate`, `configureCorridor` (immediate), `queueOrchestratorChange`, `queueTimeLockDelayChange`/`executeTimeLockDelayChange`, two-step admin transfer (`transferAdmin`/`acceptAdmin`), `cancelChange`, `getPendingChange`, `executeChange` reverts, and all events
    - Source file: `contracts/facets/TimeLockControllerFacet.sol`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 4.3 Write the DisputeResolverFacet function reference documenting `disputeSettlement` (authorization rules, check order: SettlementNotFound before UnauthorisedDisputant), reason parameter guidance, and `SettlementDisputed` event with indexed parameters
    - Source file: `contracts/facets/DisputeResolverFacet.sol`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 4.4 Write the MintBurnAuthorityFacet function reference documenting `mintFloat` and `burnFloat` (Admin-only), GSDCToken.mint/burn interaction, OZ error propagation (`OwnableUnauthorizedAccount`, `ERC20InvalidReceiver`, `ERC20InvalidSender`), zero-amount acceptance, and events (`FloatMinted`, `FloatBurned`)
    - Source file: `contracts/facets/MintBurnAuthorityFacet.sol`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 5. Write function references for operational facets
  - [x] 5.1 Write the EventEmitterFacet function reference documenting `emitSettlementBroadcast`, `emitComplianceCheck`, `emitAuditTrail` (all Orchestrator-only), and the three event signatures with indexed parameters
    - Source file: `contracts/facets/EventEmitterFacet.sol`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 5.2 Write the OracleGovernanceFacet function reference documenting `queueOracleSignersChange` (validation rules: threshold>=1, length<=10, length>=threshold, no zero addresses, no duplicates), `getOracleSigners`, `getOracleThreshold`, `isOracleSigner`
    - Source file: `contracts/facets/OracleGovernanceFacet.sol`
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 5.3 Write the PausableFacet function reference documenting `pause`, `unpause`, `isPaused`, revert conditions (`AlreadyPaused`, `NotPaused`), events (`Paused`, `Unpaused`), and which functions are blocked when paused
    - Source file: `contracts/facets/PausableFacet.sol`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 5.4 Write the DiamondLoupeFacet function reference documenting `facetAddresses`, `facetFunctionSelectors`, `facetAddress`, `supportsInterface`
    - Source file: `contracts/facets/DiamondLoupeFacet.sol`
    - _Requirements: 19.2_

  - [x] 5.5 Write the MarginSplitterFacet function reference documenting `calculateMargins` (corridorId, deliveryAmount → 3 margin values), bps calculation formula, `CorridorNotConfigured` revert, and totalDebit formula
    - Source file: `contracts/facets/MarginSplitterFacet.sol`
    - _Requirements: 12.1, 12.2, 12.3_

- [x] 6. Checkpoint - Verify facet references against source
  - Ensure all function signatures documented in tasks 3–5 exactly match the Solidity source declarations. Ask the user if questions arise.

- [x] 7. Write signing guides and token reference
  - [x] 7.1 Write the EIP-3009 Authorization Signing Guide section with step-by-step LP_Source signing flow: EIP-712 domain (name="GSDC", version="1"), TransferWithAuthorization typehash, nonce=settlementId binding, validAfter=0 requirement, validBefore constraints, 97-byte packing format, from/to/value field requirements, and signer verification
    - Source files: `contracts/GSDCToken.sol`, `contracts/EIP3009Extension.sol`, `contracts/facets/SettlementExecutorFacet.sol`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7_

  - [x] 7.2 Write the EIP-712 Oracle Quote Signing Guide section documenting OracleQuote struct encoding order, struct hash construction with keccak256(bytes(midRate)), totalDebit verification, maxQuoteTTL enforcement, and multi-signer path requirements
    - Source files: `contracts/facets/QuoteVerifierFacet.sol`
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x] 7.3 Write the GSDCToken Reference section documenting ERC-20 properties (name, symbol), EIP-3009 extension, `transferWithAuthorization` signature, `authorizationState` view function, `cancelAuthorization`, and mint/burn restriction to token owner (Diamond)
    - Source files: `contracts/GSDCToken.sol`, `contracts/EIP3009Extension.sol`
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_

  - [x] 7.4 Write the MarginWallet Interaction Guide documenting standalone per-partner contract, three immutables (gsdc, owner, settlementDiamond), `withdraw` (owner-only with reverts), `balance` view, and that deposits are raw ERC-20 transfers during settlement
    - Source file: `contracts/MarginWallet.sol`
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

- [x] 8. Write cross-cutting reference sections
  - [x] 8.1 Write the Access Control Matrix section as a markdown table mapping every external function to its required role (Admin, Orchestrator, LP_Source/LP_Dest, Pending_Admin, Public), documenting the two-step admin transfer, orchestrator time-locked rotation, view function accessibility, disputeSettlement authorization, and revert messages for unauthorized callers
    - Source files: `contracts/libraries/LibSettlement.sol`, `contracts/facets/TimeLockControllerFacet.sol`
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [x] 8.2 Write the Event Subscription Reference section organizing all events by facet with signatures, indexed parameters, and trigger conditions — including SettlementExecuted (10 fields), governance events (ChangeQueued/Executed/Cancelled), partner lifecycle events, float events, and the OracleSignersUpdated cross-facet note
    - Source files: All facet files in `contracts/facets/`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 8.3 Write the Error Reference & Handling Guide section aggregating all custom errors across all facets with 4-byte selectors, ABI-encoded parameter types, trigger conditions, suggested UI messages, the executeSettlement check order, and error decode guidance
    - Source files: All facet files in `contracts/facets/`, `contracts/GSDCToken.sol`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

- [x] 9. Write Mermaid diagrams
  - [x] 9.1 Write the Settlement Sequence Diagram (Mermaid sequenceDiagram) showing happy-path flow with participants: UI, Orchestrator, FloatManagerFacet, Oracle, QuoteVerifierFacet, LP_Source, SettlementExecutorFacet — covering reserveFloat → quote verification → EIP-3009 signing → executeSettlement → 4-leg fan-out
    - Ensure valid Mermaid v10+ syntax with no rendering errors
    - _Requirements: 1.4, 21.1, 21.5_

  - [x] 9.2 Write the executeSettlement Internal Flowchart (Mermaid flowchart TD) showing the check order: orchestrator enforcement → pause check → duplicate check → corridor active → min/max → window → partner auth → quote verify → EIP-3009 redeem → transfers (4 legs) → float release → status SETTLED → emit event
    - Use function/variable names from SettlementExecutorFacet.sol as node labels
    - _Requirements: 21.2, 21.5_

  - [x] 9.3 Write the Admin Governance Sequence Diagram (Mermaid sequenceDiagram) showing Admin → queueMarginUpdate → ChangeQueued → time delay → executeChange → ChangeExecuted, with alt block for ChangeNotReady revert when called too early
    - _Requirements: 21.3, 21.5_

  - [x] 9.4 Write the Settlement State Diagram (Mermaid stateDiagram-v2) showing PENDING(0) → EXECUTING(1) → SETTLED(2) atomic transition, with FAILED(3) annotated as unreachable/removed during CertiK audit
    - _Requirements: 21.4, 21.5_

- [x] 10. Write integration code examples
  - [x] 10.1 Write ethers.js v6 code example showing how to call `getAvailableFloat` and display the result, using `ethers.JsonRpcProvider`, `ethers.Contract`, and proper constant placeholders
    - _Requirements: 23.1_

  - [x] 10.2 Write ethers.js v6 code example showing how to construct and sign an EIP-3009 authorization using `wallet.signTypedData` with the correct domain, types, and values (nonce=settlementId, validAfter=0, from=lpSource, to=Diamond, value=totalDebit)
    - _Requirements: 23.2_

  - [x] 10.3 Write ethers.js v6 code example showing how to call `executeSettlement` with all required parameters including proper ABI encoding of the 97-byte authorizationSig
    - _Requirements: 23.3_

  - [x] 10.4 Write ethers.js v6 code example showing how to listen for `SettlementExecuted` events and parse the 10 fields
    - _Requirements: 23.4_

  - [x] 10.5 Write ethers.js v6 code example showing how to decode a custom error revert reason from a failed transaction using the contract interface's `parseError` method
    - _Requirements: 23.5_

- [x] 11. Write security considerations section
  - [x] 11.1 Write the Security Considerations section documenting: EIP-3009 nonce single-use (no reuse across settlements), never exposing oracle keys or auth signatures client-side, ReentrancyGuard on executeSettlement, two-step admin transfer preventing lock-out, cancelAuthorization for revoking unused auths, and pause scope (blocks execution/reservations but not views/withdrawals)
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6_

- [x] 12. Final verification pass
  - [x] 12.1 Verify every function signature, event, and error documented in the guide exactly matches the Solidity source declarations — cross-reference each facet section against its `.sol` file
    - Verify against: all files in `contracts/facets/`, `contracts/GSDCToken.sol`, `contracts/MarginWallet.sol`
    - _Requirements: All (Property 1: Signature Fidelity)_

  - [x] 12.2 Verify all 4 Mermaid diagrams render without syntax errors by confirming valid Mermaid v10+ syntax, consistent participant/node names matching glossary terms, and proper use of sequenceDiagram/flowchart/stateDiagram-v2 keywords
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5 (Property 5: Diagram Renderability)_

  - [x] 12.3 Verify requirements coverage by checking that every numbered acceptance criterion from requirements.md (Requirements 1–24) is addressed by a specific section in the output document
    - _Requirements: All (Property 7: Requirements Coverage)_

  - [x] 12.4 Verify the Access Control Matrix matches actual `enforceAdmin()`/`enforceOrchestrator()` calls in source, all error 4-byte selectors are correct, and event indexed parameters are accurately documented
    - _Requirements: 17.1, 16.1, 16.2, 15.1 (Properties 2, 3, 4)_

- [x] 13. Final checkpoint - Ensure document is complete
  - Ensure the document is complete, all sections are present and properly linked from the ToC, and ask the user if questions arise.

## Notes

- No automated tests are needed — this feature produces a documentation artifact, not executable code
- The design has no Correctness Properties section requiring property-based tests (structural verification is manual)
- Each task references specific Solidity source files to extract accurate information from
- Mermaid diagrams are isolated in their own task (9) to allow focused syntax verification
- Code examples are isolated in their own task (10) to ensure ethers.js v6 accuracy
- Checkpoints at tasks 6 and 13 ensure incremental validation
- The verification pass (task 12) validates correctness properties from the design document

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3", "4.4"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3", "5.4", "5.5"] },
    { "id": 5, "tasks": ["7.1", "7.2", "7.3", "7.4"] },
    { "id": 6, "tasks": ["8.1", "8.2", "8.3"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.3", "9.4"] },
    { "id": 8, "tasks": ["10.1", "10.2", "10.3", "10.4", "10.5"] },
    { "id": 9, "tasks": ["11.1"] },
    { "id": 10, "tasks": ["12.1", "12.2", "12.3", "12.4"] }
  ]
}
```
