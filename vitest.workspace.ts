/**
 * One test runner for the whole monorepo. Each project keeps its own
 * environment: node for the API and shared packages, jsdom for the POS UI.
 */
export default ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'];
