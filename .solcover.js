// solidity-coverage configuration for contracts/.
// Updated for Req 15 — 100% coverage gate.

module.exports = {
  skipFiles: [
    "interfaces/IDiamondCut.sol",
    "interfaces/IDiamondLoupe.sol",
    "interfaces/IEIP3009.sol",
    "interfaces/ISettlementDiamond.sol",
  ],
  istanbulReporter: ["html", "lcov", "text", "json-summary"],
  istanbulFolder: "./coverage",
  // configureYulOptimizer patches the Yul optimizer for instrumented builds.
  configureYulOptimizer: true,
  solcOptimizerDetails: { yul: true },
  mocha: {
    timeout: 600000,
  },
  modifierWhitelist: [],
};
