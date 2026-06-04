// solidity-coverage configuration for contracts/.
//
// [Task 3 — 90/85 gate] Enforces the repo-wide coverage gate on the
// surface that solidity-coverage can measure. Excludes interfaces that
// have no executable bytecode of their own.
//
// [Task 6 — coverage unblock] solidity-coverage 0.8.17 previously hit a
// Yul stack-too-deep on SettlementExecutorFacet under viaIR=true +
// cancun ("No memoryguard was present"). All inline assembly blocks in
// SettlementExecutorFacet are now annotated `assembly ("memory-safe")`,
// which lets the IR pipeline's stack-to-memory mover hoist locals.
// `configureYulOptimizer: true` keeps solidity-coverage's own optimizer
// patch active for safety on the instrumented build, but viaIR is no
// longer disabled — coverage now compiles against the same viaIR=true /
// cancun pipeline used in production.

module.exports = {
  skipFiles: [
    "interfaces/IDiamondCut.sol",
    "interfaces/IDiamondLoupe.sol",
    "interfaces/IEIP3009.sol",
    "interfaces/ISettlementDiamond.sol",
  ],
  // solidity-coverage 0.8.17 has no built-in numeric threshold flag.
  // The 90/85/90/90 gate is enforced in CI by the
  // `Enforce contracts coverage threshold` step in
  // .github/workflows/coverage.yml, which parses
  // contracts/coverage/coverage-summary.json (emitted by the
  // json-summary istanbul reporter below) and exits non-zero when any
  // metric is below the floor. Targets:
  //   lines      ≥ 90
  //   branches   ≥ 85
  //   functions  ≥ 90
  //   statements ≥ 90
  istanbulReporter: ["html", "lcov", "text-summary", "json-summary"],
  configureYulOptimizer: true,
  modifierWhitelist: [],
};
