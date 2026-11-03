/**
 * Marks the ESM output of a shared package as ESM.
 *
 * The packages are dual-format on purpose: the API is CommonJS (NestJS needs
 * `emitDecoratorMetadata`, which means a tsc/CJS pipeline), while the POS app
 * is bundled by Vite and wants real ESM so named exports can be statically
 * analysed -- a CJS `export *` barrel cannot be, and Rollup fails the build.
 *
 * Node decides ESM-vs-CJS by the nearest package.json `type`, and the package
 * itself is CJS, so `dist/esm` needs its own marker.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.cwd(), 'dist/esm');
mkdirSync(target, { recursive: true });
writeFileSync(resolve(target, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
