# POS for a Small Restaurant — Refined Requirements

**Version:** 0.1 (draft for build)
**Date:** 2026-11-03
**Stack decision:** TypeScript monorepo — NestJS + Prisma + PostgreSQL + Redis/BullMQ backend, React + Vite + Tailwind POS UI
**WhatsApp:** Meta WhatsApp Cloud API (official)
**Market:** India — INR, GST (CGST/SGST split)

---

## 1. The flow you described, tightened

Your original five steps, with the gaps closed:

| #   | You said                       | Refined                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Counter asks for mobile number | Phone is the **customer key** but **optional and skippable**. Normalize to E.164. Lookup returns an existing customer (name, last order, visit count) or creates a new one. Capture **explicit WhatsApp consent** at this moment — it is a legal requirement, not a nicety.               |
| 2   | Customer places order          | Cart with categories, search, item **variants** (Half/Full) and **modifier groups** (extra cheese, no onion, spice level). Qty, per-line notes. Orders can be **parked** and resumed (customer still deciding, second counter queue).                                                     |
| 3   | Order total calculated         | **Server is the only authority on money.** The client never computes a total it can submit. Line discounts, order-level discount/coupon, optional service charge, GST per item tax class with CGST/SGST split, rupee round-off. All money is **integer paise**.                           |
| 4   | Invoice sent to WhatsApp       | Business-initiated message ⇒ must use a **pre-approved utility template with a URL button** carrying the invoice token. Queued and retried, never blocking the sale. Delivery status (sent/delivered/read/failed) tracked via webhook and shown to the cashier, with a **Resend** action. |
| 5   | Invoice link sent to inbox     | Email is **optional** (only if an address is on file), sent through the same outbox/retry machinery as WhatsApp. Both channels deliver the **same tokenized invoice URL** — one document, two pipes.                                                                                      |

**The missing sixth step:** payment. An invoice is a record of a settled sale. The flow is _phone → order → totals → **tender/payment** → invoice issued → deliver_. Without it there is no POS, only an order pad.

---

## 2. Scope

### In scope (v1)

- Admin: menu management (categories, items, variants, modifiers, tax class, availability, price)
- Admin: outlet profile — legal name, address, GSTIN, FSSAI, logo, invoice footer
- Staff auth: owner/manager email+password, cashier PIN on a registered device
- POS: customer lookup by phone → cart → totals → payment → invoice
- Pricing/tax/discount engine with deterministic, test-locked arithmetic
- Immutable invoices with per-outlet, per-financial-year sequential numbering
- Public tokenized invoice page (HTML, responsive) + PDF download
- WhatsApp invoice delivery with retries, delivery receipts, opt-out handling
- Email invoice delivery
- Day close / Z-report (sales by tender, by category, tax collected, discounts, voids)
- Audit log for every money-affecting and permission-affecting action

### Explicitly out of scope (v1 backlog)

Inventory & stock depletion · Kitchen Display System / ticket printing to kitchen · Table management & floor plan · Online ordering, website, delivery-aggregator integration · Loyalty point redemption (we _record_ visits in v1) · Payroll/shift management · Multi-outlet chain reporting (schema is multi-tenant-ready; UI is single-outlet) · Thermal printer ESC/POS driver (receipt is digital-first; printing is an add-on) · Full offline-first operation (v1 ships local draft persistence + queued finalization only)

### Non-functional targets

- Add-item-to-cart interaction < 100 ms perceived; totals recalculation < 150 ms p95
- Finalize-sale API < 500 ms p95 — **notification dispatch is async and never on this path**
- POS UI usable one-handed on a 10" tablet, touch targets ≥ 44 px, keyboard shortcuts for a desktop counter
- A WhatsApp outage must not block a single sale
- Zero floating-point money anywhere in the codebase (lint-enforced)

---

## 3. Domain model (essentials)

```
Tenant ─┬─ Outlet ─┬─ StaffUser (role: OWNER|MANAGER|CASHIER)
        │          ├─ Device (registered terminal, PIN login allowed)
        │          ├─ MenuCategory ── MenuItem ─┬─ ItemVariant
        │          │                            └─ ModifierGroup ── ModifierOption
        │          ├─ TaxClass (rate bps, inclusive flag)
        │          ├─ Order ─┬─ OrderLine ── OrderLineModifier
        │          │         ├─ OrderDiscount
        │          │         └─ Payment (tender: CASH|CARD|UPI, split allowed)
        │          └─ Invoice ── InvoiceToken
        ├─ Customer (phone E.164 unique per tenant, email?, consent flags)
        └─ NotificationOutbox (channel: WHATSAPP|EMAIL, state machine, attempts)
            └─ AuditLog
```

**Order state machine:** `DRAFT → PLACED → PAID → CLOSED`, with `VOIDED` (pre-payment) and `REFUNDED` (post-payment, reason required, audited). Invoices are issued on `PAID` and are **never mutated** — a correction is a credit note, not an edit.

**Price snapshotting:** every `OrderLine` stores the name, unit price, and tax rate _as of the moment of sale_. Changing a menu price must never retroactively alter yesterday's invoice.

---

## 4. The three places this gets hard

### 4.1 WhatsApp is not an SMS gateway

- You can only freely message a customer inside a **24-hour window** opened by _their_ inbound message. A cashier-triggered invoice is **business-initiated**, so it must be a **template message** pre-approved by Meta under the **Utility** category.
- Template with a URL button: body carries `{{customer_name}}`, `{{invoice_total}}`, `{{outlet_name}}`; the button's dynamic suffix carries the invoice token. Approval takes hours to days — **submit the template during Step 1, not Step 9.**
- Requires: Meta Business verification, a dedicated phone number not registered on the consumer WhatsApp app, a permanent system-user access token, and a webhook endpoint with signature verification (`X-Hub-Signature-256`).
- Consent and `STOP`/opt-out handling are mandatory. Record consent source and timestamp.

### 4.2 Money arithmetic

- Store and compute in **integer paise**. Serialize as integers; format only at the edge.
- Define and freeze the order of operations: line total → line discount → order discount proration → taxable value → GST (CGST = SGST = rate/2) → service charge → round-off to nearest rupee. Lock it with a golden-file test suite before any UI depends on it.
- Inclusive vs exclusive tax must be a per-tax-class flag; Indian restaurant menu prices are commonly tax-inclusive.

### 4.3 Invoice link security

- Token: 128-bit URL-safe random, not sequential, not derived from the invoice number. Enumeration must be impossible.
- The page is unauthenticated (it is pasted into WhatsApp), so it must leak nothing beyond that one invoice: no customer list, no other orders, no staff names. Phone number shown masked.
- `X-Robots-Tag: noindex` and no referrer leakage on the public page.

---

## 5. Open items to confirm before Step 7

- Payment: cash/card/UPI recorded manually, or integrate a UPI dynamic-QR provider for auto-reconciliation? (v1 assumes manual recording.)
- Is a thermal receipt printer in use at the counter? Affects whether digital-only is acceptable on day one.
- Single outlet now, or is a second one planned within a year? (Schema supports it; UI effort differs.)
