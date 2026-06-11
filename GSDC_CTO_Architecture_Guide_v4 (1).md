

**THE GLOBAL SOUTH SAS**

**GSDC Platform**

*CTO Architecture & Operations Guide*

v4.0 — Post-Session Master Reference

May 2026 · Confidential · For CTO, Dev Lead, Engineering Team

| Today's Session — What We Built In a single extended CTO architecture session on 5 May 2026, we took the GSDC settlement system from a document with four unresolved open questions — chain architecture undecided, procurement pathway unclear, margin rates unconfirmed, Partner Platform PRD not yet written — to a fully specified, signed-off engineering foundation ready to build. Starting from the v2 Settlement System memo, we resolved the tech stack (EVM / Solidity / Ethereum / Sepolia testnet), selected Polygon CDK with Gateway.fm as the production chain strategy, evaluated and rejected Base on sovereignty grounds, designed the x402 modular integration architecture, mapped the MCP AI-native layer, specified and gap-analysed the PartnerAdapter Interface through two iterations to a final v1.2 sign-off, built a jurisdiction-agnostic multi-tenant Partner Platform PRD informed by live research into BCB Resolution 521 and HKMA MSO requirements, and produced eight production-quality documents. The platform is now fully specified at the architecture and product layer. The engineering team can build without ambiguity. Documents produced: 8 — CTO Architecture Guide v4 · Roadmap v4 · Settlement CTO Response · PartnerAdapter v1.0/1.1/1.2 · Partner Platform PRD v1.0/1.1 · Sign-Off Record Decisions closed: 12 major architecture decisions resolved from open to locked Status: PartnerAdapter Interface Spec v1.2: SIGNED OFF · Partner Platform PRD v1.1: SIGNED OFF · Build: READY TO START |
| :---- |

# **1\. Session Brief — 5 May 2026**

| What we set out to do Review the v2 Settlement System memo, close all open architectural questions, and produce a complete, buildable specification for the GSDC settlement platform. |
| :---- |

## **1.1 Twelve decisions made today**

| \# | Decision | Resolution |
| :---- | :---- | :---- |
| D1 | **Tech stack** | EVM · Solidity · Ethereum. Sepolia testnet for all Phase 1\. Mainnet \= Ethereum (GSDC already deployed). Chain selection (Besu vs Polygon CDK) deferred to pre-mainnet milestone. |
| D2 | **x402 integration approach** | Modular. EIP-3009 in Phase 1\. Full x402 facilitator built in Phase 4 after pilot stable. Agents-as-a-Service dropped. |
| D3 | **GSDC x402 asset type** | Native — GSDC implements EIP-3009 directly. Same standing as USDC in the x402 ecosystem. |
| D4 | **Chain sovereignty rule** | Base ruled out — US-controlled, Coinbase-operated, USDC-privileging. Incompatible with GSDC self-reliance principle. Polygon CDK (Singapore HQ) confirmed as production chain path. |
| D5 | **Production chain strategy** | GSDC Settlement Chain on Polygon CDK via AggLayer. Gateway.fm (EU) as RaaS partner for pilot proving. In-house sequencer and prover migration at scale. |
| D6 | **ZK prover approach** | Managed (Gateway.fm) for pilot at \~$5–8/month at pilot volume. Self-hosted cloud (Hetzner EU) at scale. On-prem at full corridors. Prover must be brought in-house on same timeline as sequencer. |
| D7 | **GSDC procurement (pilot)** | Pathway D — domestic OTC via Brazilian-licensed VASP. Lowest IOF risk, entire transaction within Brazil. Pathway C (private pool) built in Phase 2 in parallel. |
| D8 | **MCP integration** | GSDC MCP Server as Phase 4 component. Exposes 4 settlement tools to any MCP-compatible AI agent. Built on top of x402 facilitator. get\_quote · confirm\_settlement · get\_float\_balance · list\_settlements. |
| D9 | **Safe Harbour VM** | Not a replacement for Polygon CDK. Relevant as execution environment for off-chain components (Settlement Orchestrator, Fiat Gateway). Deferred evaluation — does not affect on-chain architecture. |
| D10 | **ComplianceCheck third state** | passed: boolean | "review". Review triggers suspicious transaction queue without blocking settlement. SANCTIONS\_LIST cannot return review — hard block only. |
| D11 | **complianceFields on settlement types** | Record\<string, string\> added to QuoteRequest and SettlementRecord. Keys driven by Corridor Profile. Jurisdiction-agnostic adapter, jurisdiction-specific data. |
| D12 | **Partner Platform architecture** | Multi-tenant platform. TGS \= operator. Each licensed institution \= independent tenant. Corridor Profiles drive all jurisdiction-specific behaviour. Adding new jurisdiction \= new Corridor Profile only. |

# **2\. System Architecture Overview**

## **2.1 The two-layer system**

The GSDC platform has two distinct layers. The Partner Platform is the web-facing interface through which licensed local partners interact with the settlement infrastructure. The Settlement Layer is the on-chain infrastructure that executes the actual atomic transfer. Both are operated by TGS from Uruguay.

## **2.2 Three-actor model**

| Actor | Institution | Role |
| :---- | :---- | :---- |
| **LP-BR** | Licensed Brazilian institution | Collects BRL from importer. Performs KYC/AML. Triggers settlement via Partner Platform. Holds GSDC float wallet. |
| **TGS Uruguay** | The Global South SAS | Issues GSDC. Operates Partner Platform and Settlement Layer. Runs DON+DAO oracle. Acts as router — not custodian, not FX dealer. |
| **LP-HK** | Licensed HK institution | Receives GSDC on-chain. Delivers CNH to Chinese end-user from pre-funded working capital. Holds GSDC float wallet. |

## **2.3 Six-layer architecture**

| Layer | Component | Description |
| :---- | :---- | :---- |
| L1 | **Oracle network** | DON+DAO — Decentralised Oracle Network with DAO governance. EIP-712 signed reports. Median aggregation. 5-min TTL. Beta complete, running on interim VMs. |
| L2 | **Smart contracts** | Solidity / EVM. GSDC ERC-20 \+ EIP-3009. Settlement Diamond (9 facets). Margin Wallet Contracts. Compliance Gate. Deployed to Sepolia testnet. |
| L3 | **Settlement Orchestrator** | Quote Engine · Settlement State Machine · idempotency · retry logic · failure recovery. Node.js/TypeScript. PartnerAdapter interface v1.2. |
| L4 | **Partner Platform** | Track A: Hosted Dashboard (pilot default). Track B: Full API \+ webhooks (post-pilot). Multi-tenant. Corridor Profiles. Jurisdiction compliance modules. |
| L5 | **Corridor adapters** | BR Adapter (PIX · BCB 519/520/521 · IOF). HK Adapter (CIPS/SWIFT · HKMA · MSO). x402 Facilitator (Phase 4). MCP Server (Phase 4). |
| L6 | **Partner integration** | Configuration only. Requires signed partner. LP-BR config (PIX key · BCB participant code · Receita Federal ID). LP-HK config (CIPS code · HKMA entity ID · MSO licence). |

## **2.4 Technology stack — all layers**

| Component | Technology | Status |
| :---- | :---- | :---- |
| **GSDC ERC-20 token** | Solidity · Ethereum mainnet · CertiK audited Dec 2025 | LIVE on Ethereum mainnet |
| **EIP-3009 extension** | Solidity · same contract · same audit cycle | Phase 1 build — Week 1 |
| **Settlement Contract (Diamond)** | Solidity · EIP-2535 · 9 facets · Sepolia | Phase 1 build — Week 1-6 |
| **DON+DAO Oracle** | EIP-712 signed · median aggregation · interim VMs | Beta complete · production migration in progress |
| **Settlement Orchestrator** | Node.js · TypeScript · PartnerAdapter v1.2 | Phase 1 build |
| **Partner Platform (Track A)** | Multi-tenant web app · Corridor Profiles · i18n | Phase 1 build — from PRD freeze |
| **Testnet / RPC** | Ethereum Sepolia · Chainstack EU (non-US) | Ready to set up — Week 1 |
| **Production chain** | Polygon CDK appchain via AggLayer · Gateway.fm RaaS | Phase 2-3 · deferred from Phase 1 |
| **x402 Facilitator** | @gsdc/x402-facilitator · EIP-3009 · CAIP-2 · 3 HTTP endpoints | Phase 4 — after pilot stable |
| **MCP Server** | @gsdc/mcp-server · 4 tools · wraps Settlement Orchestrator | Phase 4 — after x402 facilitator |
| **Cloud infrastructure** | Non-US only: Hetzner EU / OVH / Contabo | Setup Week 1 |

# **3\. Complete Component Inventory**

Every module in the system classified by ring, layer, phase, and current build status.

| Module | Class | Layer | Phase | Status | Notes |
| :---- | :---- | :---- | :---- | :---- | :---- |
| GSDC ERC-20 Token | **CORE** | L2 | LIVE | **done** | CertiK audited Dec 2025\. Deployed Ethereum mainnet. |
| EIP-3009 (Transfer With Authorization) | **CORE** | L2 | P1 | **ready** | Add to existing token contract. Same audit cycle as Settlement Contract. Prerequisite for x402. |
| DON+DAO Oracle Contract | **CORE** | L1 | P1 | **inprog** | Beta complete. Running on interim VMs. Oracle contract to deploy to Sepolia. IT infra decision made — VMs confirmed. |
| Settlement Contract — 9-facet Diamond | **CORE** | L2 | P1 | **ready** | Quote Verifier · Float Manager · Settlement Executor · Margin Splitter · Compliance Gate · Time-Lock · Dispute Resolver · Event Emitter · Mint/Burn Authority. |
| Margin Wallet Contracts | **CORE** | L2 | P1 | **ready** | Per-partner accumulation and withdrawal. Same build cycle as Settlement Contract. |
| PartnerAdapter Interface Spec v1.2 | **CORE** | L3 | P1 | **done** | SIGNED OFF. complianceFields added. Three-state ComplianceCheck. All 18 gaps resolved. |
| MockAdapter | **CORE** | L3 | P1 | **ready** | Implements full PartnerAdapter interface v1.2 with fake fiat rails. Unblocked by sign-off. |
| Quote Engine | **CORE** | L3 | P1 | **ready** | Corridor \+ amount → oracle rate → fee stack → signed quote \+ TTL. Needs PartnerAdapter freeze (done) \+ Oracle live. |
| Settlement State Machine | **CORE** | L3 | P1 | **ready** | 6 states \+ idempotency \+ retries \+ failure recovery. Needs PartnerAdapter freeze (done). |
| Audit & Reconciliation Layer | **CORE** | L4 | P1 | **ready** | On-chain event indexer · ledger sync · mismatch alert · corridor freeze. |
| Partner Platform — Track A (Hosted Dashboard) | **CORE** | L4 | P1 | **ready** | PRD v1.1 SIGNED OFF. Multi-tenant · Corridor Profiles · Jurisdiction compliance modules. Build starts from PRD freeze. |
| Partner Platform — Track B (Full API) | **CORE** | L4 | P3 | **deferred** | Post-pilot. Separate PRD to be written after pilot stable. |
| Corridor Profile Config API | **CORE** | L4 | P1 | **ready** | Serves Corridor Profile data to dashboard at session init. Supports Jurisdiction-agnostic architecture. |
| BR Adapter (generic → configured) | **ADAPTER** | L5 | P2 | **ready** | PIX · BCB 519/520/521 · IOF · eFX fields. Draft from Week 8\. |
| HK Adapter (generic → configured) | **ADAPTER** | L5 | P2 | **ready** | CIPS/SWIFT · HKMA MSO · suspicious tx queue. Draft from Week 8\. |
| x402 Facilitator (@gsdc/x402-facilitator) | **ADAPTER** | L5 | P4 | **deferred** | POST /verify · POST /settle · GET /supported. Reuses @x402/evm types. Requires EIP-3009 live. |
| x402 Corridor Adapter module | **ADAPTER** | L5 | P4 | **deferred** | Routes x402 micropayments to Settlement Engine. |
| x402 Session Manager | **ADAPTER** | L5 | P4 | **deferred** | V2 wallet-based identity. Reduces handshake latency for repeat callers. |
| MCP Server (@gsdc/mcp-server) | **ADAPTER** | L5 | P4 | **deferred** | 4 tools: get\_quote · confirm\_settlement · get\_float\_balance · list\_settlements. |
| x402 Audit Feed extension | **ADAPTER** | L4 | P4 | **deferred** | Micropayment events indexed alongside settlement events. |
| LP-BR Integration config | **PARTNER** | L6 | P2 | **blocked** | Config only. Requires signed LP-BR partner. |
| LP-HK Integration config | **PARTNER** | L6 | P2 | **blocked** | Config only. Requires signed LP-HK partner. |

| Status key | Meaning |
| :---- | :---- |
| **done** | Complete and signed off. No further changes without CTO approval. |
| **inprog** | Build in progress. Oracle beta running on interim VMs. |
| **ready** | Ready to build. All prerequisites met or will be met this week. |
| **deferred** | Scheduled for a future phase. Does not block current work. |
| **blocked** | Blocked on external dependency (partner contract, legal opinion). |

# **4\. Master Todo List — All Phases**

## **This Week — Starts Immediately**

| \# | Task | Owner | Why unblocked |
| :---- | :---- | :---- | :---- |
| 1 | **Set up Sepolia RPC via Chainstack EU** | Sandip | Tech stack confirmed. Non-US provider. Start today. |
| 2 | **Deploy Diamond scaffold (EIP-2535) to Sepolia** | Sandip | Reference implementation exists. Configuration only. |
| 3 | **Commit PartnerAdapter TypeScript interface file to repo** | Dev Lead | Spec v1.2 signed off. This is the build artefact from the spec. |
| 4 | **Begin MockAdapter implementation against v1.2 interface** | Dev Lead | Unblocked by sign-off. 1 week. |
| 5 | **Scope and start EIP-3009 on GSDC token contract** | Smart contract dev | One well-defined interface addition. Same audit cycle. |
| 6 | **Begin Partner Platform project scaffold \+ auth \+ i18n** | Frontend \+ backend | PRD v1.1 signed off. Scaffold, 2FA, i18n framework start now. |
| 7 | **Identify Pathway D OTC counterparty in Brazil** | CEO / COO | Required before pilot go-live. No engineering dependency. |
| 8 | **Chase Brazilian counsel IOF opinion** | Legal / COO | Gates Pathway C decision and off-ramp cost model. |
| 9 | **Board confirmation of 0.5/0.5/0.5 margin rates** | COO / CEO | Required before any partner term sheet is signed. |

## **Phase 1 — Core Build (Weeks 1–14)**

| ID | Task | Owner | Effort | Dependency |
| :---- | :---- | :---- | :---- | :---- |
| 1.1 | **Sepolia RPC \+ dev environment (Chainstack EU)** | Sandip | 1 day | Nothing |
| 1.2 | **Deploy Diamond scaffold to Sepolia** | Sandip | 1 day | 1.1 |
| 1.3 | **EIP-3009 on GSDC token contract** | Smart contract dev | 1 wk | 1.1 |
| 1.4 | **Settlement Contract — 9-facet Diamond build and deploy to Sepolia** | Sandip | 4–6 wk | 1.1 · v1.2 spec |
| 1.5 | **Margin Wallet Contracts** | Smart contract dev | incl. 1.4 | 1.1 |
| 1.6 | **CertiKit audit submission (Settlement Contract \+ EIP-3009)** | CTO | — | 1.4 1.5 code freeze |
| 1.7 | **Oracle aggregator contract deploy to Sepolia (DON+DAO)** | Oracle team | 2–3 wk | 1.1 · interim VMs (done) |
| 1.8 | **Quote Engine (corridor \+ amount → oracle → fee → quote \+ TTL)** | Dev Lead / Sandip | 3–4 wk | v1.2 spec · 1.7 |
| 1.9 | **Settlement State Machine (6-state · idempotency · retries)** | Dev Lead / Sandip | 5–7 wk | v1.2 spec · 1.8 |
| 1.10 | **Commit PartnerAdapter v1.2 TypeScript interface to repo** | Dev Lead | Day 1 | Sign-off (done) |
| 1.11 | **MockAdapter full implementation against v1.2** | Dev Lead | 1 wk | 1.10 |
| 1.12 | **Corridor Profile Config API** | Backend dev | 2 wk | v1.2 spec |
| 1.13 | **Partner Platform — project scaffold \+ auth \+ 2FA \+ i18n** | Frontend \+ backend | 2 wk | PRD v1.1 (done) |
| 1.14 | **Partner Platform — multi-tenancy data model \+ RBAC** | Backend dev | 2 wk | PRD v1.1 (done) |
| 1.15 | **Partner Platform — home screen \+ settlement feed** | Frontend | 3 wk | 1.13 1.14 |
| 1.16 | **Partner Platform — quote request \+ dual-approval flow \+ compliance fields** | Frontend | 4 wk | 1.13 1.14 1.12 |
| 1.17 | **Partner Platform — float management \+ margin wallet** | Frontend | 2 wk | 1.13 1.14 |
| 1.18 | **Partner Platform — reconciliation \+ BCB daily report generator** | Frontend \+ backend | 3 wk | 1.14 |
| 1.19 | **Partner Platform — HK MSO compliance module** | Frontend \+ backend | 2 wk | 1.14 |
| 1.20 | **Partner Platform — notification system** | Backend | 2 wk | 1.14 |
| 1.21 | **Audit and Reconciliation Layer (event indexer · ledger sync · mismatch alert)** | Backend dev | 3–4 wk | v1.2 spec |
| 1.22 | **End-to-end testnet: all contracts \+ orchestrator \+ MockAdapter both sides** | QA \+ Dev Lead | 1 wk | 1.4 1.8 1.9 1.21 |
| 1.23 | **EIP-3009 security review (CertiK)** | Smart contract dev \+ CertiK | incl. 1.6 | 1.3 |

## **Phase 2 — Adapters (Weeks 8–18)**

| ID | Task | Owner | Effort | Dependency |
| :---- | :---- | :---- | :---- | :---- |
| 2.1 | **Draft generic BR Adapter spec (PIX · BCB · IOF · eFX · complianceFields)** | Dev Lead \+ legal | 1 wk | v1.2 spec |
| 2.2 | **Draft generic HK Adapter spec (CIPS · HKMA · MSO · suspicious tx)** | Dev Lead \+ legal | 1 wk | v1.2 spec |
| 2.3 | **Build BR Adapter generic implementation** | Backend dev | 3 wk | 2.1 |
| 2.4 | **Build HK Adapter generic implementation** | Backend dev | 3 wk | 2.2 |
| 2.5 | **Testnet: BR Adapter (real) \+ HK MockAdapter** | QA \+ Dev Lead | 1 wk | 2.3 1.22 |
| 2.6 | **Testnet: BR MockAdapter \+ HK Adapter (real)** | QA \+ Dev Lead | 1 wk | 2.4 1.22 |
| 2.7 | **Lock LP-BR partner-specific config on signing** | Dev Lead \+ LP-BR | — | 2.3 · partner signed |
| 2.8 | **Lock LP-HK partner-specific config on signing** | Dev Lead \+ LP-HK | — | 2.4 · partner signed |
| 2.9 | **Onboard LP-BR ops team to Track A staging** | Product \+ LP-BR | 1 wk | 1.22 2.7 |
| 2.10 | **Onboard LP-HK ops team to Track A staging** | Product \+ LP-HK | 1 wk | 1.22 2.8 |
| 2.11 | **Pathway C private pool engineering begins (parallel)** | Smart contract dev | 4 mo | IOF counsel · 2.1 |

## **Phase 3 — Pilot Live (Weeks 18–26)**

| ID | Task | Owner | Effort | Dependency |
| :---- | :---- | :---- | :---- | :---- |
| 3.1 | **Go-live: first BR→CN settlement (constrained volume, manual approval each)** | CTO \+ ops | — | 2.7 2.8 1.6 audit |
| 3.2 | **Monitor: audit layer watching every settlement for discrepancy** | Ops \+ Dev Lead | ongoing | 3.1 |
| 3.3 | **Confirm corridor economics over 4–8 weeks live volume** | COO \+ CTO | — | 3.1 |
| 3.4 | **Partner technical discovery calls (HashKey / FOMO Pay / StraitsX)** | CMO / CEO | 1–2 mo | — |
| 3.5 | **Polygon CDK engagement — confirm Gateway.fm contract and chain setup timeline** | CTO | — | 3.3 |
| 3.6 | **Build Partner API \+ webhooks (Track B) — begins after pilot stable** | Backend dev | 6–8 wk | 3.3 |
| 3.7 | **Draft \+N corridor adapter specs (IN, ZA, TH, ID) — generic profiles** | Dev Lead | ongoing | 3.3 v1.2 |
| 3.8 | **Phase 4 prerequisites checklist: EIP-3009 live · pilot volume baseline · no open contract issues** | CTO | — | 3.3 1.23 |
| 3.9 | **Phase 4 go/no-go decision** | CTO \+ CEO | — | 3.8 |

## **Phase 4 — x402 \+ MCP Modular Layer (After pilot stable)**

| ID | Task | Owner | Effort | Dependency |
| :---- | :---- | :---- | :---- | :---- |
| 4.1 | **Apply for x402 Foundation membership (Linux Foundation)** | CEO \+ CTO | — | 3.9 |
| 4.2 | **Build @gsdc/x402-facilitator (POST /verify · POST /settle · GET /supported)** | Dev Lead | 3–4 wk | 3.9 · EIP-3009 live |
| 4.3 | **Register GSDC as x402 payment asset (CAIP-2 chain ID)** | Dev Lead \+ CTO | 1 day | 4.2 |
| 4.4 | **Build x402 Corridor Adapter module — Layer 5 plug-in** | Dev Lead / Sandip | 2 wk | 4.2 v1.2 |
| 4.5 | **x402 session management (repeat caller identity)** | Backend dev | 1 wk | 4.4 |
| 4.6 | **Security review: EIP-3009 front-running on PAYMENT-SIGNATURE header** | Smart contract dev \+ auditor | 1 wk | 4.2 |
| 4.7 | **x402 micropayment daily volume cap in facilitator** | Dev Lead | 3 days | 4.4 |
| 4.8 | **Extend Audit Layer with x402 event feed** | Backend dev | 1 wk | 1.21 4.4 |
| 4.9 | **Testnet: AI agent makes x402 GSDC payment end-to-end** | QA \+ Dev Lead | 1 wk | 4.2 4.4 4.5 |
| 4.10 | **Build @gsdc/mcp-server (4 tools wrapping Settlement Orchestrator)** | Dev Lead | 2 wk | 4.2 |
| 4.11 | **Publish GSDC to x402 Bazaar discovery layer** | Dev Lead | 1 day | 4.3 4.9 |
| 4.12 | **MCP server testnet: Claude agent calls get\_quote and confirm\_settlement** | QA | 1 wk | 4.10 |
| 4.13 | **Mainnet go-live for x402 \+ MCP at constrained volume** | CTO \+ ops | — | 4.6 4.7 4.8 4.9 4.12 |

## **Phase 5 — GSDC Settlement Chain (Own appchain)**

| ID | Task | Owner | Effort | Dependency |
| :---- | :---- | :---- | :---- | :---- |
| 5.1 | **Gateway.fm RaaS contract signed** | CTO \+ CEO | — | 3.5 |
| 5.2 | **GSDC Chain local CDK testnet (Docker quickstart)** | Sandip | 1 day | 5.1 |
| 5.3 | **GSDC Chain Sepolia testnet (Gateway.fm managed prover)** | Gateway.fm \+ Sandip | 1–2 wk | 5.1 |
| 5.4 | **Deploy all settlement contracts to GSDC Chain testnet** | Sandip | 1 wk | 5.3 |
| 5.5 | **Bridge contracts audit (CertiK — chain layer)** | CTO \+ CertiK | 2–3 wk | 5.4 |
| 5.6 | **AggLayer registration \+ CAIP-2 chain ID registration** | Dev Lead \+ Gateway.fm | 1 wk | 5.3 |
| 5.7 | **Block explorer (Blockscout self-hosted)** | Sandip | 1 day | 5.3 |
| 5.8 | **Sequencer in-house migration (TGS runs own sequencer)** | Sandip \+ ops | 2 wk | volume justification |
| 5.9 | **Prover in-house migration (TGS runs own prover on Hetzner EU)** | Sandip \+ ops | 2 wk | 5.8 |
| 5.10 | **GSDC Chain mainnet go-live — migration from Ethereum mainnet** | CTO \+ ops | — | 5.5 5.8 5.9 |

# **5\. Open Decisions — What Still Gates Build**

All architecture and product decisions are now closed. The following items are non-engineering — legal, commercial, or board decisions. None block Phase 1 engineering. All should be resolved in parallel.

| P | Item | Owner | Gates |
| :---- | :---- | :---- | :---- |
| P0 | **Pathway D OTC counterparty identification** | CEO / COO | Required before pilot go-live. Identify domestic Brazilian-licensed VASP this month. |
| P0 | **Brazilian counsel IOF opinion** | Legal / COO | Gates Pathway C engineering decision and off-ramp cost model viability. |
| P1 | **Board confirmation of 0.5/0.5/0.5 margin rates** | COO / CEO | Required before any partner term sheet. Engineering uses configurable marginBps\[3\] — board decision changes config not code. |
| P1 | **LP-BR partner signed** | CMO / CEO | Gates adapter config lock (2.7) and pilot go-live (3.1). Phase 1 builds without this. |
| P1 | **LP-HK partner signed** | CMO / CEO | Gates adapter config lock (2.8) and pilot go-live (3.1). Phase 1 builds without this. |
| P2 | **Partner technical discovery (HashKey / FOMO Pay / StraitsX)** | CMO / CEO | Informs post-pilot chain preference and corridor expansion. No Phase 1 impact. |
| P2 | **Polygon CDK lifecycle commitment from Polygon Labs** | CTO | Written 5-year CDK enterprise roadmap commitment before signing with Gateway.fm. |
| P2 | **QuickPay codebase licensing (Uruguayan counsel)** | Legal / CTO | Chain-of-title for audit. Does not block Solidity build. |
| P2 | **CertiKit quote on audit duration** | CTO | Timing input for pilot go-live date. Request as soon as code freeze is visible. |

# **6\. Document Registry — Everything Produced**

All documents produced across the full architecture session. Read in order for new team members.

| Document | Version | Status | Purpose |
| :---- | :---- | :---- | :---- |
| **CTO Architecture & Operations Guide** | v4.0 | **done** | This document. Master reference for architecture, components, roadmap, and todo list. |
| **Master Roadmap & Todo List** | v4.0 | **done** | Phase-by-phase build plan with owners and dependencies. Embedded in this document as Section 4\. |
| **Settlement CTO Response to v2** | v3.0 | **done** | Closes all four open questions in the Settlement System v2 memo. Primary document for CEO/COO. |
| **PartnerAdapter Interface Specification** | v1.2 FINAL | **done** | SIGNED OFF. All 18 gaps resolved. Four cross-check fixes. Three-state compliance. complianceFields on settlement types. |
| **Partner Platform PRD — Track A** | v1.1 FINAL | **done** | SIGNED OFF. Multi-tenant. Corridor Profiles. BCB/HKMA compliance modules. 14 jurisdictional gaps resolved. |
| **CTO Sign-Off Record** | May 2026 | **done** | Formal record of both sign-offs. Four fixes documented. Change control rules. What each person starts this week. |
| **PartnerAdapter v1.2 Delta** | v1.2 delta | **done** | Read alongside v1.1. Contains only changed types and new compliance decision tree section. |
| **CTO Architecture Guide v3** | v3.0 | **deferred** | Previous version. Superseded by this document. Retain for audit history. |

## **6.1 Reading order for new engineering team members**

* 1\. This document (CTO Architecture Guide v4) — start here for the full picture

* 2\. Settlement CTO Response v3 — understand the six-step settlement flow and three-actor model

* 3\. PartnerAdapter Interface Spec v1.1 — full interface spec with all types

* 4\. PartnerAdapter v1.2 delta — the four changes applied at sign-off

* 5\. Partner Platform PRD v1.1 — what is being built for the partner-facing layer

* 6\. Sign-Off Record — change history and what everyone starts this week