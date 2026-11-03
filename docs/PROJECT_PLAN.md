# Project Plan — 10 Steps, One Feature at a Time

Each step is **independently shippable and demoable**. No step depends on a later step's code.
Rule for every step: backend first with tests, then the UI that consumes it, then the acceptance demo.

> **Do this on day one, in parallel with Step 1:** start Meta Business verification and submit the
> WhatsApp utility template for approval. It is the only item with an external lead time measured in
> days. If it waits until Step 9, Step 9 waits with it.

---

## Step 1 — Foundation & skeleton

**Goal:** a running, typed, tested, containerized shell with the tenancy spine in place.

- pnpm monorepo: `apps/api` (NestJS), `apps/pos` (React + Vite + Tailwind), `packages/contracts` (shared Zod schemas + inferred types), `packages/money` (integer-paise primitives).
- Docker Compose: PostgreSQL 16 + Redis 7. Prisma with migrations committed.
- Config via Zod-validated env (fail fast on boot). Structured JSON logging with request IDs. `/healthz` + `/readyz`.
- Global error envelope `{ error: { code, message, details } }`, global validation pipe, stable error codes.
- Models: `Tenant`, `Outlet`. Seed script creates one tenant/outlet with GSTIN placeholders.
- `packages/money`: `Paise` branded type, add/sub/mulBps/roundToRupee, and an ESLint rule banning float math on money.
- CI: typecheck → lint → unit tests → migration check.

**Acceptance:** `docker compose up` + `pnpm dev` serves the API and a POS shell; `/healthz` green; seed produces a tenant; CI passes on a clean clone.

---

## Step 2 — Staff auth, devices & audit log

**Goal:** nobody touches money anonymously.

- `StaffUser` (OWNER | MANAGER | CASHIER), Argon2id password for owner/manager, 4–6 digit PIN (hashed, rate-limited, lockout after N failures) for cashiers.
- `Device` registration: a terminal is paired once with a long-lived device token; PIN login is only permitted from a registered device.
- JWT access (15 min) + rotating refresh token; role guard + `@Roles()` decorator; tenant/outlet scoping resolved from the token on every request, never from the request body.
- `AuditLog`: actor, action, entity, before/after diff, IP, device — written by an interceptor, not by hand at each call site.
- UI: admin login page, POS PIN pad / cashier switch, session banner showing who is on the till.

**Acceptance:** a cashier logs in by PIN on a paired device only; a manager action appears in the audit log; brute-force attempts are locked out.

---

## Step 3 — Menu management (admin)

**Goal:** the restaurant owner can model their real menu without you.

- `MenuCategory`, `MenuItem` (name, description, image, base price in paise, `TaxClass`, `isAvailable`, sort order), `ItemVariant` (Half/Full with price delta), `ModifierGroup` (min/max select, required) + `ModifierOption` (price delta).
- `TaxClass`: rate in basis points, `isInclusive` flag — pre-seeded with the 5% / 12% / 18% GST slabs.
- Published menu endpoint `GET /menu` returning a denormalized, cache-friendly payload with an ETag; a `menuVersion` bumps on any change.
- Admin UI: category/item CRUD, drag-to-reorder, image upload to object storage, bulk availability toggle ("Paneer sold out"), price edit with an audit entry.

**Acceptance:** the owner builds a 30-item menu with variants and modifiers through the UI; `GET /menu` returns it in one call and 304s on an unchanged ETag; marking an item unavailable hides it from the POS instantly.

---

## Step 4 — Customer identity by phone

**Goal:** Step 1 of your flow, done properly.

- `Customer`: `phoneE164` (unique per tenant, normalized with libphonenumber-js, default region IN), optional name/email, `whatsappConsent` + `consentSource` + `consentAt`, `emailConsent`, visit count, last order at.
- `POST /customers/lookup` → `{ customer | null, recentOrders: 3 }`. Idempotent find-or-create on confirm.
- PII posture: phone/email encrypted at rest, masked in all logs, masked in API responses (`+91 ·····9876`) except on the POS lookup screen.
- UI: the POS opening screen — large numeric keypad, as-you-type formatting, **Skip (walk-in)** always one tap away, returning-customer card ("Priya · 7 visits · last: Masala Dosa ×2"), and an explicit consent checkbox whose exact wording is recorded.

**Acceptance:** typing `9876543210` resolves a returning customer in under 200 ms; a new number creates a customer only after the cashier confirms; Skip produces a valid walk-in order path; consent is stored with its wording and timestamp.

---

## Step 5 — Order & cart engine

**Goal:** build an order; totals come in Step 6.

- `Order` (number, state `DRAFT`, outlet, cashier, customer?, orderType DINE_IN | TAKEAWAY, note), `OrderLine` (**snapshot** of item name, variant, unit price, tax rate, qty, note), `OrderLineModifier` (snapshot too).
- Server-authoritative mutations: `POST /orders`, `POST /orders/:id/lines`, `PATCH /orders/:id/lines/:lineId`, `DELETE`. The client sends what the customer asked for, never prices.
- **Idempotency-Key** header on all order mutations; optimistic concurrency via a `version` column to make double-taps safe.
- Park/resume: multiple open drafts per terminal, labelled by customer name or token number, with a parked-orders tray.
- UI: the main POS screen — category rail, item grid with large touch tiles, fuzzy search, modifier bottom sheet, live cart with qty steppers and swipe-to-remove, keyboard shortcuts for a desktop counter.

**Acceptance:** a 10-line order with variants and modifiers is built in under 60 seconds of touch input; double-tapping Add never duplicates a line; two parked orders resume correctly after a page reload.

---

## Step 6 — Pricing, tax & discount engine

**Goal:** one pure function that is the single source of truth for money.

- A **pure, side-effect-free calculator** in `packages/pricing`: `calculate(orderSnapshot, config) → TotalsBreakdown`. No DB, no clock, no I/O — therefore exhaustively testable.
- Frozen order of operations: line gross → line discount → order discount (prorated across lines, remainder-safe) → taxable value → GST split (CGST = SGST = rate/2, with back-calculation where the tax class is inclusive) → service charge → round-off to the nearest rupee, with the delta recorded as `roundOffPaise`.
- Discounts: percentage or flat, line or order level, capped, reason code required, manager-approval threshold.
- **Golden test suite:** 40+ fixture cases committed as JSON — inclusive/exclusive, mixed slabs, 100% discount, odd-paise proration, single-paise rounding. These tests are the specification.
- `GET /orders/:id/totals` returns the full breakdown; the UI only renders it.
- UI: totals panel with an expandable tax breakdown, discount dialog with reason, tax-inclusive indicator.

**Acceptance:** every golden case passes; across all fixtures the sum of taxable values plus taxes plus round-off equals the grand total to the paise; the UI never displays a number the server did not send.

---

## Step 7 — Payment, finalization & invoice numbering

**Goal:** close the sale. This is where an order pad becomes a POS.

- `Payment`: tender `CASH | CARD | UPI`, amount, reference, **split tender** across multiple rows, change-due computation for cash.
- `POST /orders/:id/finalize` — one transactional endpoint: re-runs the pricing engine server-side, validates that payments sum to the grand total, moves `PLACED → PAID`, allocates the invoice number, writes the immutable invoice snapshot. Idempotent by key.
- **Invoice numbering:** per outlet, per financial year, gap-free sequential (`INV/2026-27/000142`) via a dedicated counter row with `SELECT … FOR UPDATE`. Never `MAX()+1`, never a sequence that can gap or race.
- Void (pre-payment) and refund (post-payment, manager role, mandatory reason, credit-note record) — both fully audited.
- UI: payment modal with quick-cash buttons (₹500 / ₹1000 / exact), split-tender rows, change-due display, success screen showing the invoice number.

**Acceptance:** concurrent finalizations from two terminals produce two distinct, gap-free invoice numbers; a payment-total mismatch is rejected with a clear error; a refund leaves the original invoice byte-identical and creates a credit note.

---

## Step 8 — Invoice document & public tokenized link

**Goal:** the artifact both channels will deliver. Build it before the pipes.

- `Invoice`: immutable JSON snapshot (outlet legal block, GSTIN, masked customer, lines, full tax breakdown, payments, timestamps) — rendering never re-queries live menu or customer data.
- `InvoiceToken`: 128-bit URL-safe random, optional expiry, revocable, view counter. Route `GET /i/:token`.
- Public invoice page: server-rendered, mobile-first (it will be opened inside the WhatsApp in-app browser), prints cleanly, Download PDF button. `noindex`, no referrer leakage, strict CSP, per-token rate limiting.
- PDF generated from the same template (headless Chromium), cached to object storage on first request.
- UI: invoice preview on the POS success screen plus a Copy link action.

**Acceptance:** a finalized order yields a link that renders correctly at 360 px width and as a one-page PDF; enumeration attempts are rate-limited and leak nothing; changing a menu price afterwards does not alter the rendered invoice.

---

## Step 9 — WhatsApp delivery

**Goal:** Step 4 of your flow, production-grade.

- `NotificationOutbox` row written **inside** the finalize transaction (transactional outbox — a message can never be lost, nor sent for a sale that rolled back). A BullMQ worker drains it.
- `WhatsAppProvider` interface with a Meta Cloud API implementation (template message, URL-button dynamic suffix = invoice token) and a stub provider for dev/tests.
- Retries with exponential backoff and jitter, capped attempts, dead-letter state; per-error-code handling — invalid number vs. rate limit vs. template paused, and only the retryable ones retry.
- Webhook `POST /webhooks/whatsapp`: `X-Hub-Signature-256` verification, idempotent by message ID, maps `sent/delivered/read/failed` onto the outbox row; an inbound `STOP` flips consent off.
- Per-message cost and usage log for billing visibility.
- UI: delivery-status chip on the success screen and in order history (Queued → Sent → Delivered → Read / Failed) with **Resend** and **Send to a different number**.

**Acceptance:** finalizing a sale delivers a WhatsApp message with a working invoice button within seconds; killing the worker mid-queue loses nothing on restart; a WhatsApp API outage still returns the sale as successful with the message left in `RETRYING`; `STOP` suppresses all future sends to that number.

---

## Step 10 — Email delivery, day close & operational hardening

**Goal:** the second pipe, plus what it takes to actually run this in a restaurant.

- Email through the same outbox and worker (Amazon SES or Resend): HTML invoice email carrying the tokenized link and the PDF, plain-text fallback, bounce/complaint webhook turning `emailConsent` off.
- Unified **delivery dashboard** for the manager: per-order channel status, failure reasons, bulk resend.
- **Day close / Z-report:** sales by tender, by category, GST collected (CGST/SGST), discounts with reasons, voids and refunds, cash expected vs. counted with variance — locked once closed, exportable as PDF/CSV.
- Resilience: POS drafts persisted locally (IndexedDB) so a crash or Wi-Fi blip loses no in-progress order; finalize queued and replayed on reconnect under its idempotency key.
- Ops: metrics (sales/min, finalize p95, outbox depth, delivery failure rate), alerting, nightly encrypted Postgres backup with a documented restore drill, rate limits, dependency audit, deploy runbook.

**Acceptance:** a sale to a customer with an email address delivers on both channels; the Z-report reconciles to the paise against the day's orders; pulling the network cable mid-order loses nothing and the sale completes on reconnect; a restore drill is performed and documented.

---

## Dependency order

```
1 ──▶ 2 ──┬─▶ 3 ─┬─▶ 5 ──▶ 6 ──▶ 7 ──▶ 8 ──┬─▶ 9
          └─▶ 4 ─┘                          └─▶ 10

(Meta business verification + WhatsApp template approval runs alongside steps 1–8)
```

Steps 3 and 4 are independent of each other and can be built in either order or in parallel.
Steps 9 and 10 are independent once 8 lands.

## Definition of done (every step)

Unit tests on logic · integration tests on endpoints against a real Postgres · the UI slice wired to the real API with no mocks · reversible migrations · no new TypeScript or ESLint errors · README section updated · the acceptance demo performed end to end.
