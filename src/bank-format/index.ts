// Shared bank format module, contract v1 (docs/design/bank-format.md).
// Pure: no filesystem access. The validator and the briefing/glossary
// generator build on these exports.
export * from './constants.ts';
export * from './text.ts';
export * from './paths.ts';
export * from './violations.ts';
export * from './manifest.ts';
export * from './root-map.ts';
