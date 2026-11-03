import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Money-safety rules.
 *
 * All money in this codebase is an integer number of paise (`Paise` in
 * @pos/money). Floating point must never touch it: `0.1 + 0.2 !== 0.3`, and a
 * fraction of a paise in a tax calculation becomes a mismatched invoice.
 *
 * These are syntactic guards, not a type system -- they catch the common
 * mistakes (toFixed, parseFloat, dividing a money variable) rather than every
 * possible one. The real guarantee is the `Paise` branded type plus the golden
 * test suite landing in Step 6.
 */
const MONEY_IDENTIFIER = '/([Pp]aise|[Pp]rice|[Aa]mount|[Tt]otal|[Ss]ubtotal|[Tt]ax)$/';

const moneySafety = {
  'no-restricted-globals': [
    'error',
    {
      name: 'parseFloat',
      message: 'Money is integer paise. Use parseInt/Number on a paise integer, never parseFloat.',
    },
  ],
  'no-restricted-properties': [
    'error',
    {
      object: 'Number',
      property: 'parseFloat',
      message: 'Money is integer paise. Number.parseFloat has no place in this codebase.',
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.property.name='toFixed']",
      message:
        'toFixed() implies float money. Format paise with formatPaise() from @pos/money instead.',
    },
    {
      selector: `BinaryExpression[operator='/'][left.name=${MONEY_IDENTIFIER}]`,
      message:
        'Dividing a money value truncates or produces a float. Use divideBps/splitEvenly from @pos/money.',
    },
    {
      selector: `BinaryExpression[operator='/'][right.name=${MONEY_IDENTIFIER}]`,
      message:
        'Dividing by a money value produces a float. Keep money arithmetic inside @pos/money.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/api/prisma/migrations/**',
      'apps/pos/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...moneySafety,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },
  {
    // NestJS leans on decorator metadata and parameter properties.
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
      /*
       * Off here on purpose, and it must stay off.
       *
       * A constructor parameter whose class is only referenced in type
       * position still has to be a *value* import: `emitDecoratorMetadata`
       * compiles that type into the runtime DI token. Rewriting
       * `import { PrismaService }` to `import type { PrismaService }` erases
       * the token and Nest injects `undefined` -- which fails at request time,
       * not at build time.
       */
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['apps/pos/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Scripts and tests print to stdout on purpose.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/prisma/seed.ts', '**/scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
