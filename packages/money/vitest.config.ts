import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'money',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
