# Design Document: GSDC UI Developer Guide

## Overview

This design specifies the structure, format, and content organization of a comprehensive markdown reference document targeting UI/frontend developers who integrate with the GSDC Settlement Diamond system. The deliverable is a single static markdown file containing architecture explanations, function signatures, Mermaid diagrams, error references, code examples, and security guidance.

**Key design decision:** The guide is a standalone `.md` file (not generated from code) because:
1. The target audience (UI devs) reads documentation outside the Solidity source tree
2. Mermaid diagrams and ethers.js examples cannot be embedded in Solidity NatSpec
3. A single navigable document reduces onboarding friction vs. scattered contract comments

The document covers all 13 Diamond facets, the GSDCToken contract, and the MarginWallet contract, organized around the settlement lifecycle flow rather than alphabetical facet ordering — this mirrors how a UI developer actually encounters the system.

## Architecture

The guide itself is a documentation artifact, not a runtime system. The architecture describes how the document is structured and generated:

```
docs/
└── GSDC_UI_Developer_Guide.md    ← Single output file (~3000-4000 lines)
```

### Document Generation Strategy

- **Manual authoring** based on source contracts (no auto-gen tooling required)
- **Source of truth:** The Solidity source files in `contracts/facets/`, `contracts/libraries/`, `contracts/interfaces/`, `contracts/GSDCToken.sol`, and `contracts/MarginWallet.sol`
- **Verification:** Each function signature, event, and error documented in the guide MUST be verified against the corresponding `.sol` file
- **Format:** GitHub-Flavored Markdown (GFM) with Mermaid fenced code blocks

### Section Ordering Rationale

The document follows a "progressive disclosure" pattern:
1. **Architecture context first** — so the reader understands Diamond proxying before diving into facets
2. **Lifecycle flow second** — establishes the mental model of the full settlement journey
3. **Per-facet references third** — ordered by lifecycle position, not alphabetically
4. **Cross-cutting concerns last** — errors, events, security, and code examples

## Components and Interfaces

The "components" in this context are the major sections of the output document and the formatting conventions they use.

### Document Sections (in order)

| # | Section | Purpose |
|---|---------|---------|
| 1 | Title & Table of Contents | Navigation with anchor links |
| 2 | Glossary | Term definitions (matches requirements.md glossary) |
| 3 | Diamond Architecture Overview | EIP-2535 explanation, single-proxy pattern, DiamondLoupe |
| 4 | Settlement Lifecycle (end-to-end) | 6-step lifecycle narrative + sequence diagram |
| 5 | Settlement State Machine | States, transitions, state diagram |
| 6 | Corridor & Window Configuration | Corridor fields, window formula, immediate vs time-locked |
| 7 | Function Reference — SettlementExecutorFacet | Signatures, params, reverts, events |
| 8 | Function Reference — QuoteVerifierFacet | Single + aggregated paths, EIP-712 domain |
| 9 | Function Reference — FloatManagerFacet | Reserve/release/query |
| 10 | Function Reference — ComplianceGateFacet | Partner lifecycle |
| 11 | Function Reference — TimeLockControllerFacet | Queue/execute/cancel pattern |
| 12 | Function Reference — MarginSplitterFacet | Fee calculation |
| 13 | Function Reference — DisputeResolverFacet | Dispute submission |
| 14 | Function Reference — MintBurnAuthorityFacet | Mint/burn float |
| 15 | Function Reference — EventEmitterFacet | Audit trail events |
| 16 | Function Reference — OracleGovernanceFacet | DON signer management |
| 17 | Function Reference — PausableFacet | Emergency pause |
| 18 | Function Reference — DiamondLoupeFacet | Introspection |
| 19 | EIP-3009 Authorization Signing Guide | Step-by-step LP_Source signing |
| 20 | EIP-712 Oracle Quote Signing Guide | Quote construction and verification |
| 21 | GSDCToken Reference | ERC-20 + EIP-3009 interface |
| 22 | MarginWallet Interaction Guide | Per-partner margin contract |
| 23 | Access Control Matrix | Role → function mapping table |
| 24 | Event Subscription Reference | All events by facet with indexed params |
| 25 | Error Reference & Handling Guide | All custom errors with decode guidance |
| 26 | Code Flow Diagrams | 4 Mermaid diagrams (sequence, flowchart, state) |
| 27 | Integration Code Examples | ethers.js v6 snippets |
| 28 | Security Considerations | Nonce reuse, key exposure, reentrancy |

### Formatting Conventions

#### Function Signature Format

Each function is documented in a consistent block:

```markdown
### `functionName`

```solidity
function functionName(type1 param1, type2 param2) external returns (type3)
```

**Access:** Admin-only / Orchestrator-only / Public  
**Mutability:** state-changing / view / pure

| Parameter | Type | Description |
|-----------|------|-------------|
| param1 | type1 | Semantic description |
| param2 | type2 | Semantic description |

**Returns:**  
| Field | Type | Description |
|-------|------|-------------|
| ... | ... | ... |

**Reverts:**  
| Error | Condition |
|-------|-----------|
| `ErrorName(type)` | When X happens |

**Events emitted:**  
- `EventName(indexed param1, param2)` — emitted when...
```

#### Mermaid Diagram Format

All diagrams use fenced code blocks with `mermaid` language identifier:

````markdown
```mermaid
sequenceDiagram
    participant UI
    participant Orchestrator
    ...
```
````

Diagram conventions:
- Participant names use Glossary terms (UI, Orchestrator, Diamond, LP_Source, LP_Dest, Oracle)
- Function calls use `FacetName.functionName()` notation
- Error paths shown with `--x` (cross) arrows or `alt` blocks
- Notes placed above participants for important constraints

#### Code Example Format

All code examples use TypeScript with ethers.js v6:

````markdown
```typescript
import { ethers } from "ethers";

// Description of what this example demonstrates
const provider = new ethers.JsonRpcProvider(RPC_URL);
const diamond = new ethers.Contract(DIAMOND_ADDRESS, ISettlementDiamondABI, provider);
// ... example code
```
````

Conventions:
- Placeholder constants in UPPER_CASE (e.g., `DIAMOND_ADDRESS`, `RPC_URL`)
- Comments explain each step
- Error handling included in transaction examples
- No hardcoded private keys in examples

## Data Models

Since this is a documentation feature, "data models" refers to the structured data formats documented within the guide.

### Key Structs Documented

#### Settlement (LibSettlement.Settlement)
```
{
  settlementId: bytes32,
  quoteId: bytes32,
  corridorId: bytes32,
  lpSource: address,
  lpDest: address,
  deliveryAmount: uint256,
  totalDebit: uint256,
  lpSourceMargin: uint256,
  tgsTreasuryMargin: uint256,
  lpDestMargin: uint256,
  status: uint8,          // 0=PENDING, 1=EXECUTING, 2=SETTLED, 3=FAILED
  createdAt: uint256,
  settledAt: uint256
}
```

#### CorridorConfig (LibSettlement.CorridorConfig)
```
{
  active: bool,
  minDeliveryAmount: uint256,
  maxDeliveryAmount: uint256,    // 0 = unbounded
  lpSourceMarginBps: uint16,
  tgsTreasuryMarginBps: uint16,
  lpDestMarginBps: uint16,
  settlementWindowStart: uint32, // UTC seconds from midnight
  settlementWindowEnd: uint32
}
```

#### OracleQuote (QuoteVerifierFacet.OracleQuote)
```
{
  quoteId: bytes32,
  corridorId: bytes32,
  deliveryAmount: uint256,
  totalDebit: uint256,
  lpSourceMarginBps: uint256,
  tgsTreasuryMarginBps: uint256,
  lpDestMarginBps: uint256,
  validAfter: uint256,
  validBefore: uint256,
  midRate: string,
  isOverridden: bool
}
```

#### EIP-3009 Authorization Signature Layout (97 bytes)
```
Byte offset  | Size  | Field
0–31         | 32    | uint256(validBefore)
32–63        | 32    | bytes32(r)
64–95        | 32    | bytes32(s)
96           | 1     | uint8(v)
```

### Access Control Matrix Format

Documented as a markdown table:

| Function | Required Role | Revert on unauthorized |
|----------|--------------|------------------------|
| executeSettlement | Orchestrator | "LibSettlement: not orchestrator" |
| queueMarginUpdate | Admin | "LibSettlement: not admin" |
| disputeSettlement | lpSource/lpDest/Orchestrator | UnauthorisedDisputant(caller) |
| getAvailableFloat | Public | — |

### Mermaid Diagram Specifications

The guide includes exactly 4 Mermaid diagrams as specified in Requirement 21:

1. **Settlement Sequence Diagram** — `sequenceDiagram` type, 6 participants, ~20 messages
2. **executeSettlement Internal Flowchart** — `flowchart TD` type, ~15 nodes representing the check order
3. **Admin Governance Sequence** — `sequenceDiagram` type with `alt` block for the ChangeNotReady case
4. **Settlement State Diagram** — `stateDiagram-v2` type with 4 states and transition annotations

## Error Handling

### Document Error Coverage

The guide documents errors at three levels:

1. **Per-function level** — Each function reference lists its specific revert conditions
2. **Per-facet level** — Error summary table at the end of each facet section
3. **Global error reference** — Section 25 aggregates ALL custom errors across all facets with:
   - 4-byte selector (first 4 bytes of `keccak256(errorSignature)`)
   - ABI-encoded parameter types
   - Trigger condition description
   - Suggested UI message / recovery action

### Error Decode Guidance

The guide includes a code example showing how to:
1. Extract the 4-byte selector from revert data
2. Match it against the known error selectors
3. ABI-decode the parameters
4. Map to a user-friendly message

## Correctness Properties

Since this feature produces a documentation artifact (not executable code), formal correctness properties are expressed as structural invariants the output document must satisfy:

### Property 1: Signature Fidelity

For every function documented in the guide, the function name, parameter types, parameter order, return types, and visibility modifier MUST exactly match the corresponding declaration in the Solidity source file.

**Validates: Requirements 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12**

### Property 2: Error Completeness

For every custom `error` declaration in each facet's Solidity source, a corresponding entry MUST exist in the guide's error reference section with the correct 4-byte selector and parameter types.

**Validates: Requirements 16**

### Property 3: Event Completeness

For every `event` declaration that is emitted (not just declared) by a facet, a corresponding entry MUST exist in the guide's event reference section with correct indexed/non-indexed parameter annotations.

**Validates: Requirements 15**

### Property 4: Access Control Accuracy

For every function listed in the access control matrix, the documented required role MUST match the actual `enforceAdmin()`, `enforceOrchestrator()`, or caller-check logic in the Solidity source.

**Validates: Requirements 17**

### Property 5: Diagram Renderability

All 4 Mermaid diagrams MUST parse without errors when processed by Mermaid v10+ (validated via `mmdc` CLI or equivalent renderer).

**Validates: Requirements 21**

### Property 6: Code Example Validity

All ethers.js v6 code examples MUST be syntactically valid TypeScript that type-checks against `@types/ethers` v6 type definitions.

**Validates: Requirements 23**

### Property 7: Requirements Coverage

Every numbered acceptance criterion in `requirements.md` MUST be traceable to a specific section in the output document.

**Validates: Requirements 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24**

## Testing Strategy

Since this feature produces a documentation artifact (not executable code), traditional unit tests and property-based tests do not apply. Instead, the quality assurance strategy focuses on:

### Verification Approach

1. **Source accuracy verification** — Each documented function signature, event, and error MUST be manually cross-referenced against the corresponding Solidity source file. The task list will include a verification step per facet.

2. **Mermaid syntax validation** — All 4 Mermaid diagrams MUST render without syntax errors when processed by Mermaid v10+. This can be verified using the Mermaid CLI (`mmdc`) or by previewing in a Mermaid-compatible markdown viewer.

3. **Code example compilation** — All ethers.js v6 code examples MUST be syntactically valid TypeScript. They will be verified by type-checking against the `ethers` v6 type definitions (no runtime execution required since they reference deployed contract addresses).

4. **Requirements coverage** — A final review pass will verify that every acceptance criterion in `requirements.md` is addressed by the output document, tracked via a coverage checklist.

5. **Consistency checks:**
   - All Glossary terms used consistently throughout
   - All function names match actual Solidity identifiers
   - All error names match actual Solidity custom error declarations
   - All event signatures match actual Solidity event declarations
   - Access control matrix matches actual `enforceAdmin()` / `enforceOrchestrator()` calls in source

### No Property-Based Testing

PBT is not applicable to this feature because:
- The deliverable is a static markdown document, not executable code
- There are no pure functions with input/output behavior to test
- There is no input space to generate random values over
- The correctness criteria are structural (document completeness and accuracy) rather than behavioral

Standard documentation review practices (source cross-referencing, diagram rendering, syntax validation) provide appropriate coverage.
