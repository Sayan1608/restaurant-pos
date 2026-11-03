# Step 1, explained in plain language

**What Step 1 was for:** we did not build any part of the till yet. We built the _workbench_ —
the foundation that every later step is bolted onto, plus the one piece of maths the whole system
depends on.

Think of opening a restaurant. Before you cook a single dish you need the building, the power, the
water, the gas line, and a set of accurate weighing scales. Step 1 is that. Steps 2–10 are the
cooking.

---

## The short version

Six things now exist that did not exist before:

1. A project that runs, with one command, on any machine.
2. A **money calculator** that cannot make rounding mistakes.
3. A **shared rulebook** so the screen and the server can never disagree about data.
4. A **database** that knows about the restaurant and its location.
5. A **"is everything working?" check** the app can ask at any time.
6. An **automatic inspector** that re-checks the whole project on every change.

Everything below explains those six in ordinary words.

---

## 1. A project that runs with one command

The code is split into four parts that live in one folder:

| Part                 | In plain words                                                      |
| -------------------- | ------------------------------------------------------------------- |
| `apps/api`           | The **server**. The brain. Does the thinking, owns the database.    |
| `apps/pos`           | The **screen**. What the cashier touches. Shows things, takes taps. |
| `packages/money`     | The **calculator**. Shared by both.                                 |
| `packages/contracts` | The **rulebook**. Shared by both.                                   |

Why split them? Because the screen must never be trusted with money. The cashier's tablet says
_"the customer wants two dosas"_; the server decides _"that costs ₹249.50 including tax"_. If the
screen could decide the price, anyone who knows how to open a browser could change it.

To start everything: `pnpm dev`. To start the database: `pnpm db:up`. That is it. A new developer
(or you, on a new laptop) does not need a page of setup instructions.

---

## 2. The money calculator — the most important thing we built

### The problem

Computers are bad at decimal money. This is genuinely true, in every programming language:

```
0.1 + 0.2  =  0.30000000000000004
```

Not a typo. Computers store decimals in binary, and some decimals have no exact binary form —
the same way 1/3 has no exact decimal form (0.3333…). So the answer is very slightly wrong.

One wrong digit twenty places after the decimal point sounds harmless. It is not. Add up 200
bills a day, each slightly wrong, and your day-end cash total does not match your till. Worse, a
GST invoice is a **legal document**. If the tax line does not add up to the total, the invoice is
wrong in the eyes of a tax authority.

### The fix

**We never store rupees. We store paise, as whole numbers.**

₹249.50 is stored as `24950`. There is no decimal point, so there is nothing to round wrongly.
Whole numbers are always exact. We only put the decimal point back at the last moment, when
printing it on screen or on the invoice.

This is not a clever trick we invented — it is how banks and payment companies do it.

### What the calculator knows how to do

Four jobs that are easy to get wrong, now written once and tested hard:

**Reading a typed amount.** If someone types `249.50`, we convert the _text_ straight to `24950`.
We deliberately refuse to accept a decimal number here at all, because that is where the error
would sneak in.

**Rounding tax.** 18% of ₹249.50 is ₹44.91. The rule we chose is "round half up, away from zero"
— ordinary shop rounding, the kind Indian GST calculation expects. The rule is written down in
one place, so it can never be applied differently in two parts of the app.

**Taking tax _out_ of a price.** This one surprises people. Indian restaurant menus usually show
prices with tax already included. If a dish is ₹100 on the menu at 5% GST, how much of that ₹100
is tax?

The wrong answer is ₹5.00. The right answer is **₹4.76**, because the ₹100 is the total, not the
pre-tax price (₹95.24 + 5% = ₹100). Getting this backwards overstates tax on every single bill.
Our calculator does it correctly, and a test checks it for thousands of price-and-rate
combinations.

**Splitting a discount fairly.** Say you give a ₹10 discount on a bill with three items. The
discount has to be spread across the three lines so the tax on each line is right.

₹10 ÷ 3 = ₹3.333… each. If you round each one down you get ₹3.33 + ₹3.33 + ₹3.33 = **₹9.99**.
You have just lost one paisa. The bill will not balance, and someone will eventually spend an
afternoon hunting for it.

Our method gives `₹3.34 + ₹3.33 + ₹3.33 = ₹10.00` exactly — the leftover paisa is handed to one
line rather than vanishing. There is a test that tries about a thousand different amounts and
five different item combinations and checks the pieces always add back up perfectly.

### Making the rule impossible to ignore

A rule nobody enforces is a suggestion. So the project now **refuses to accept** code that does
money maths the dangerous way — if someone writes the kind of decimal arithmetic that causes these
bugs, the automatic inspector stops it before it is ever saved. The habit is enforced by the tools,
not by someone remembering.

---

## 3. The shared rulebook

The screen and the server are two separate programs talking over the internet. The classic bug is
that they slowly stop agreeing. The server starts calling something `total`; the screen is still
looking for `amount`. Nothing crashes — the screen just shows a blank where the total should be.
On a POS, that blank is next to a customer waiting to pay.

So we wrote the shape of every message down **once**, in a place both of them read
(`packages/contracts`). Both sides check every message against it. If they ever disagree, we get a
loud, specific error instead of a silently empty bill.

The rulebook also fixes **one standard format for every error**:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Order not found.",
    "requestId": "fbd6384e-04bc-480d-98b7-184810dea413"
  }
}
```

Three deliberate choices in that little block:

- **`code`** is for the app. A fixed, never-changing label the screen can react to.
- **`message`** is for the human. The wording can be improved any time without breaking anything.
- **`requestId`** is for support. Every single request gets a unique id, which also appears in the
  server's own log. So when a cashier rings up and says "it said something went wrong", that id is
  all you need to find the exact entry in the log. Without it you are searching a haystack.

One more rule: **if the server has an internal fault, the customer-facing message says only
"Something went wrong."** The real detail goes to the log. Error messages are a classic way for a
database password or a file path to leak out to anyone looking. There is a test that deliberately
throws a fake password and checks it never reaches the response.

---

## 4. The database

We created the two tables everything else will hang off:

- **Tenant** — the restaurant business.
- **Outlet** — a physical location: its legal name, address, GSTIN, FSSAI licence, currency,
  timezone, and the footer text printed on its invoices.

### Why two tables when there is only one restaurant?

Because every future table — orders, invoices, menu items — will carry a note saying _which outlet
this belongs to_. That costs nothing today. Adding it later, to a table already full of real
invoices, means a risky migration on live financial data. We paid a one-hour cost now to avoid a
genuinely frightening job later.

### Why the outlet stores its own timezone

Because "today's sales" is not obvious. If the till closes at 1am, that sale belongs to the
previous business day. The day-end report (Step 10) and the invoice numbering (Step 7) both depend
on knowing _the restaurant's_ idea of a day — not the server's, which might be sitting in another
country.

### Migrations and the seed

Two small ideas that save a lot of pain:

- A **migration** is a recorded, numbered change to the database structure, saved in the project.
  We never change the database by hand. That way the structure on your laptop, on a colleague's
  laptop, and on the real server is provably identical.
- The **seed** fills a fresh database with one example restaurant so you can start working
  immediately. Running it twice does not create a duplicate — it checks first.

---

## 5. The "is everything working?" check

Two addresses the app can be asked at any moment:

- **`/healthz` — "are you alive?"** Answers from the server itself and deliberately does _not_
  touch the database. If the database hiccups for two seconds, we do not want the hosting platform
  to decide the app is broken and restart it mid-sale.
- **`/readyz` — "can you actually serve customers?"** This one _does_ check the database, and
  reports how fast it answered. If the database is unreachable it says so plainly, and returns a
  specific "not available" signal that a load balancer understands and acts on.

That is why the screen you can open at `localhost:5173` right now shows a green **Connected** pill
and `postgres · up · 96ms`. It is asking those two questions every fifteen seconds. In Step 10 this
same mechanism becomes the "you are offline" warning banner for the cashier — the single most
important thing a cashier needs to know before taking an order.

---

## 6. The automatic inspector

Five checks now run over the entire project, on demand and automatically on every change:

| Check         | What it catches                                                         |
| ------------- | ----------------------------------------------------------------------- |
| **format**    | Inconsistent layout. Removes a whole category of pointless arguing.     |
| **lint**      | Risky patterns — including the banned money maths.                      |
| **typecheck** | Mismatched data, e.g. treating text as a number. Caught before running. |
| **test**      | 89 tests. Behaviour that used to work and must keep working.            |
| **build**     | Proves the thing can actually be packaged for a real server.            |

The point is that these run **without anyone remembering to run them**. A mistake gets caught in
seconds by a machine, rather than in a month by a customer. That matters more with each step: by
Step 7 this project is handling real payments, and the tests written now are what let you change
code then without fear.

---

## What you can look at right now

Open **http://localhost:5173**. You will see:

- A **status panel** — the live answer from the two health checks above, including how long the
  database took to respond. Proof the screen and the server are genuinely talking.
- A **money panel** — a few amounts run through the real calculator, showing both the stored whole
  number and the formatted output (`₹1,00,000.00`, grouped the Indian way with lakhs, not the
  American way).
- A **roadmap** — the ten steps, with Step 1 ticked.

This screen is scaffolding, not a design. The actual POS screens arrive in Steps 4 and 5 and will
replace it.

---

## What we deliberately did _not_ build

So nothing comes as a surprise:

- No login yet — that is Step 2.
- No menu, no items, no prices — Step 3.
- No customers, no phone numbers — Step 4.
- No orders, no cart, no bill total — Steps 5 and 6.
- No payment, no invoice, no WhatsApp — Steps 7 to 10.

The money calculator exists already even though the first bill is five steps away, because
_everything_ later depends on it. Building it first, with heavy tests, means the hardest arithmetic
in the project is finished and trustworthy before anything is built on top of it.

---

## A few words you will keep hearing

**API** — the server's menu of requests the screen is allowed to make. "Create an order",
"look up this phone number".

**Endpoint** — one item on that menu, e.g. `/readyz`.

**Schema** — the agreed shape of some data. Our rulebook is made of schemas.

**Migration** — one recorded change to the database structure.

**Seed** — sample data to start from.

**Paise** — 1/100 of a rupee. All our money is stored as a whole number of these.

**GSTIN** — the 15-character tax registration number that must appear on a tax invoice.

**Idempotent** — "doing it twice has the same effect as doing it once". Our seed is idempotent.
From Step 5 onward, so are orders — that is what stops a cashier's double-tap charging a customer
twice.

---

## Up next: Step 2

Staff login. Owners and managers sign in with a password; cashiers tap a short PIN on a tablet that
has been paired to the restaurant once. Plus an **audit log** — a permanent record of who did what,
so no action that touches money is ever anonymous.
