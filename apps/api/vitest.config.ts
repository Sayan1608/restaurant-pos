import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * NestJS depends on `emitDecoratorMetadata` for constructor injection, which
 * esbuild (vitest's default transformer) does not implement. SWC does, so the
 * API's tests are transformed with it -- otherwise every injected dependency
 * resolves to `undefined` at runtime.
 */
export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
  plugins: [swc.vite({ module: { type: 'nodenext' } })],
});
