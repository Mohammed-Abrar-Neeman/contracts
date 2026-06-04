// Helper for diamond cut selectors. Mirrors the Nick Mudge reference helper
// adapted for ethers v6.
import { Interface, FunctionFragment } from "ethers";

export function getSelectors(iface: Interface): string[] {
  const selectors: string[] = [];
  iface.forEachFunction((f: FunctionFragment) => {
    selectors.push(f.selector);
  });
  return selectors;
}

export function removeSelectors(selectors: string[], excludeSighashes: string[]): string[] {
  return selectors.filter((s) => !excludeSighashes.includes(s));
}

export const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 } as const;
