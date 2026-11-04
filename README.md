# Restaurant POS

Point-of-sale for a small restaurant: the cashier takes the customer's mobile number, builds the
order, takes payment, and the invoice is delivered to the customer's WhatsApp and email as a link.

**Stack:** pnpm monorepo — NestJS + Prisma + PostgreSQL + Redis/BullMQ (`apps/api`),
React + Vite + Tailwind (`apps/pos`), shared contracts and money primitives in `packages/*`.
WhatsApp via the Meta WhatsApp Cloud API. Currency INR, GST with CGST/SGST split.

## Planning docs

- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — refined scope, domain model, the hard parts, open questions
- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) — the 10 build steps, each independently shippable
- [`docs/STEP-01-EXPLAINED.md`](docs/STEP-01-EXPLAINED.md) — what Step 1 built and why, in plain language

## Status

**Step 1 of 10 complete** — foundation, tenancy spine, money primitives, health probes, CI.
Next: Step 2, staff auth, devices and the audit log.

## Getting started

Requires Node ≥ 20.12, pnpm 9 and Docker.

```bash
cp .env.example .env     # host ports are 5434 (postgres) and 6380 (redis)
pnpm install             # also builds the shared packages
pnpm db:up               # start postgres + redis
pnpm db:migrate          # apply migrations
pnpm db:seed             # one tenant, one outlet
pnpm dev                 # api on :3001, POS on :5173
```

Open http://localhost:5173 — the shell shows the live API and dependency status.
Probes: `curl localhost:3001/healthz` and `curl localhost:3001/readyz`.

### Scripts

| Command              | What it does                                           |
| -------------------- | ------------------------------------------------------ |
| `pnpm dev`           | API (watch) + POS (Vite) + shared packages (tsc watch) |
| `pnpm test`          | Whole-monorepo vitest run                              |
| `pnpm test:coverage` | Same, with coverage and threshold enforcement          |
| `pnpm test:unit`     | Unit tests only — skips the tests that need a database |
| `pnpm typecheck`     | `tsc --noEmit` in every package                        |
| `pnpm lint`          | ESLint, including the money-safety rules               |
| `pnpm format`        | Prettier write                                         |
| `pnpm build`         | Builds packages, API and POS in dependency order       |
| `pnpm db:migrate`    | Create and apply a migration                           |
| `pnpm db:reset`      | Drop, re-migrate and re-seed                           |
| `pnpm db:studio`     | Prisma Studio                                          |

## Testing

```bash
pnpm test              # everything
pnpm test:coverage     # + coverage report in coverage/index.html, thresholds enforced
pnpm test:unit         # no database needed
```

Three layers, each answering a question the others cannot:

- **Unit** — pure logic. All of `@pos/money` lives here, including a brute-force
  invariant over ~1000 amounts × 5 weight shapes proving a prorated discount always sums back
  exactly.
- **Component / HTTP** — controllers with Prisma stubbed, and the POS UI against a mocked
  `fetch`. Fast, and they assert the response _contract_, not just the status code.
- **Integration** (`*.integration.test.ts`) — the whole app booted with the real modules and a
  real PostgreSQL. These need the database up (`pnpm db:up && pnpm db:migrate`); `pnpm test:unit`
  skips them.

The integration tests assert the guarantees the _database_ makes — unique constraints, `onDelete:
Restrict`, defaults, transaction rollback — because an application-level check can be bypassed by a
bug or a script, while a constraint cannot. Those rules protect financial records, so they are
tested against Postgres rather than a mock.

Coverage sits at ~99% of lines with thresholds enforced in CI. The small remainder is
unreachable defensive code (a division-by-zero guard, a filesystem-root walk) left deliberately
uncovered rather than excluded, so it stays visible in the report.

## Layout

```
apps/
  api/            NestJS. CommonJS -- NestJS DI needs emitDecoratorMetadata.
    prisma/       Schema, migrations, seed
    src/common/   Error envelope filter, ApiException, Zod pipe
    src/config/   Env schema -- the only place process.env is read
    src/health/   Liveness and readiness probes
  pos/            React + Vite + Tailwind v4. ESM, bundled.
packages/
  money/          Integer-paise arithmetic. The money rules live here.
  contracts/      Zod schemas shared by client and server: error envelope,
                  health, tenancy, HTTP header names.
```

## Decisions worth knowing before you touch this

**Money is an integer number of paise, always.** `packages/money` owns every operation —
rounding is half away from zero, applied only where the pricing engine says. ESLint blocks
`toFixed`, `parseFloat` and division on money-named identifiers; `splitByWeights` exists because
naive rounding of a prorated discount loses paise and makes an invoice that does not reconcile.
58 tests pin this down, and Step 6 adds the golden fixture suite on top.

**The shared packages are dual-format (CJS + ESM).** The API must be CommonJS because NestJS
resolves constructor injection through `emitDecoratorMetadata`, which needs a tsc pipeline; Vite
wants real ESM so named exports are statically analysable (a CJS `export *` barrel is not, and
Rollup fails on it). `pnpm install` builds them via the root `prepare` script, so a fresh clone
works without a manual build step.

**`consistent-type-imports` is off for `apps/api` on purpose.** A constructor parameter's class is
only referenced in type position but still has to be a _value_ import — `import type` erases the
DI token and Nest silently injects `undefined` at request time.

**One `.env` at the workspace root.** The API finds it by walking up to `pnpm-workspace.yaml` and
loading it with Node's built-in loader; real environment variables always win, so containers and CI
override without a file. Prisma CLI scripts read the same file via `dotenv-cli`.

**Host database ports are 5434 and 6380**, not the defaults, and are parameterised
(`POSTGRES_PORT` / `REDIS_PORT`) — 5432 and 6379 are usually already taken by another local stack.

**Health probes sit outside the `/v1` prefix.** Liveness never touches a dependency (a database
blip is not a reason to be restarted); readiness checks every hard dependency and answers 503 when
degraded, so a load balancer acts on it. Redis joins the readiness check in Step 9 when BullMQ
starts using it.

## Before Step 9

Start Meta Business verification and submit the WhatsApp **utility** message template for approval
now. It is the only external dependency with a lead time measured in days, and Step 9 cannot ship
without it.
