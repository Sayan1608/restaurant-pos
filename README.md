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
- [`docs/STEP-02-EXPLAINED.md`](docs/STEP-02-EXPLAINED.md) — what Step 2 built and why, in plain language

## Status

**Steps 1–2 of 10 complete.**

- **Step 1** — foundation, tenancy spine, integer-paise money primitives, health probes, CI.
- **Step 2** — staff auth (password + cashier PIN), device pairing, rotating sessions, audit log.

Next: Step 3, menu management.

## Getting started

Requires Node ≥ 20.12, pnpm 9 and Docker.

```bash
cp .env.example .env     # host ports are 5434 (postgres) and 6380 (redis)
pnpm install             # also builds the shared packages
pnpm db:up               # start postgres + redis
pnpm db:migrate          # apply migrations
pnpm db:seed             # one tenant, one outlet, demo staff
pnpm dev                 # api on :3001, POS on :5173
```

Open http://localhost:5173. A fresh till is unpaired, so it asks for a pairing code — click
**Sign in as a manager** and use the credentials the seed prints:

| Role    | Sign in with                                                     |
| ------- | ---------------------------------------------------------------- |
| Owner   | `owner@spicegarden.test` / `owner-dev-password-1`                |
| Manager | `manager@spicegarden.test` / `manager-dev-password-1`            |
| Cashier | PIN `1234` (Priya Menon) or `4321` (Rahul Das), on a paired till |

Development credentials only — the seed skips them when `NODE_ENV=production`.

To pair a till, sign in as the manager and `POST /v1/devices/pairing-codes`, then enter the code on
the till. Probes: `curl localhost:3001/healthz` and `curl localhost:3001/readyz`.

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

## Security model (Step 2)

**Two sign-ins, because a restaurant has two situations.** Owners and managers use email +
password (12 characters minimum — length over composition rules). Cashiers tap their name and enter
a 4–6 digit PIN. Name-then-PIN rather than PIN-only: a bare PIN would have to be unique per outlet
for the server to identify who typed it, which leaks that a PIN is taken and caps the number of
cashiers.

**A short PIN is only defensible because three things hold at once**, and each has its own test:
the PIN works only on a manager-paired till; the account locks after `LOGIN_MAX_ATTEMPTS`; and the
PIN is Argon2id-hashed. Remove any one and the arrangement fails.

**Two hashing strategies, deliberately.** Argon2id (19 MiB, t=2, ~26 ms) for passwords and PINs,
because a human chose them and each guess must be expensive. Plain SHA-256 for device and refresh
tokens, because they are 256 bits of randomness — there is nothing to brute-force, a slow hash
would buy nothing, and a fast digest allows an indexed lookup. Only fingerprints are ever stored,
so a database leak yields no working credential.

**Sign-in failures are indistinguishable.** Wrong password, unknown email and ineligible account
all return the same code, the same message, and roughly the same time — the last via a dummy
Argon2 verification, so a missing account does not answer faster than a wrong password. A locked
account is the one deliberate exception, because a manager locked out mid-service needs to know why.

**Refresh tokens rotate, and replay is treated as theft.** Each use issues a new token and revokes
the old, linked in a chain. Presenting an already-rotated token revokes _every_ session for that
staff member: we cannot distinguish a broken client from a stolen token, and logging out an honest
user is a far smaller harm than leaving an attacker with a session on a system that takes payments.
The POS client coalesces concurrent refreshes for the same reason — two parallel rotations would
look like theft and log the till out.

**Closed by default.** `AccessTokenGuard` is global, so a new endpoint is shut until it carries
`@Public()`. The opposite arrangement means an endpoint added in a hurry is wide open with nothing
in the code saying so. Roles are explicit with no hierarchy: a manager route is written
`@Roles('OWNER', 'MANAGER')`, because implicit inheritance is how an owner-only action quietly
becomes manager-accessible later.

**The audit trail is append-only and self-redacting.** No endpoint can modify or delete a row.
`actorLabel` denormalises the actor's name at write time, so renaming or deactivating staff cannot
rewrite history. Any field whose name matches `password|pin|token|secret|hash|authorization|cookie`
is replaced with `[redacted]` at the boundary rather than relying on callers to remember. A failed
audit write never fails the operation it describes — that trade-off reverses in Step 7, where
money-affecting rows are written inside the business transaction.

**One rate-limit bucket, tightened per route.** `ThrottlerGuard` applies _every_ named definition
to _every_ route, so a second bucket named `auth` with a limit of 10 silently caps the whole API at
10 requests a minute — and cannot be escaped with a bare `@SkipThrottle()`, which only skips the
bucket literally named `default`. A test asserting the health probes are never throttled is what
caught this.

## Layout

```
apps/
  api/            NestJS. CommonJS -- NestJS DI needs emitDecoratorMetadata.
    prisma/       Schema, migrations, seed
    src/audit/    Append-only audit trail (service, redaction, read API)
    src/auth/      Sign-in, guards, tokens, hashing
    src/common/   Error envelope filter, ApiException, Zod pipe
    src/config/   Env schema -- the only place process.env is read
    src/devices/  Till pairing and revocation
    src/health/   Liveness and readiness probes
    src/staff/    Staff administration
  pos/            React + Vite + Tailwind v4. ESM, bundled.
    src/lib/      Session store, auth client, auth context
    src/screens/  Pair till, PIN pad, manager login, home
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
