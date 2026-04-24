export * from '../../node_modules/@craft-ng/core';

export type AngularBrandDeps = {
  injected?: readonly unknown[];
  importDeps?: readonly unknown[];
  providers?: readonly unknown[];
};

export function deps(value: AngularBrandDeps = {}): AngularBrandDeps {
  return value;
}

export function brandAngularSymbol<T extends object>(
  angularSymbol: T,
  _dependencyGroups?: AngularBrandDeps,
): T {
  return angularSymbol;
}
