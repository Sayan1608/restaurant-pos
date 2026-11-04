import { defineConfig } from 'vitest/config';

/**
 * Root config. The per-project settings (environment, includes) live in each
 * package's own vitest.config.ts and are picked up through vitest.workspace.ts;
 * coverage is a whole-run concern, so it is configured once, here.
 *
 * Thresholds are set just under the current numbers rather than at some round
 * aspiration: they are a ratchet that fails the build when coverage drops, not
 * a target to chase.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      exclude: [
        // Process entry points: a few lines of wiring whose only meaningful
        // test is starting the real app, which the integration tests do.
        'apps/api/src/main.ts',
        'apps/pos/src/main.tsx',
        // Test scaffolding and type-only barrels.
        '**/*.test.{ts,tsx}',
        '**/src/test/**',
        '**/index.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
