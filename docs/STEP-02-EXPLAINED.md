# Step 2, explained in plain language

**What Step 2 was for:** making sure nobody touches money anonymously.

Step 1 built the workbench. Step 2 puts a lock on the door, gives each member of
staff their own key, and starts a logbook that records who opened what and when.

---

## The short version

Four things now exist:

1. **Two ways to sign in**, because a restaurant has two different situations.
2. **Tills that are paired once** and then remember themselves.
3. **A permanent logbook** of everything that happened.
4. **A locked-by-default API** — every new endpoint is closed until someone opens it.

---

## 1. Two ways to sign in

### Owners and managers: email and password

Normal sign-in, from anywhere. Passwords must be at least 12 characters.

We chose **length over complexity rules**. "P@ssw0rd!" satisfies every "must contain a symbol"
rule ever written and is terrible; "correct horse battery staple" breaks all of them and is far
stronger. Complexity rules mostly teach people to write their password on a sticky note next to
the till.

### Cashiers: tap your name, type a PIN

A cashier cannot stop to type an email address and a passphrase between customers. So they tap
their name on a list and enter a 4–6 digit PIN.

A 4-digit PIN has only 10,000 possibilities. On its own that would be unacceptable. **Three
things make it safe, and all three are required:**

| Protection                                | What it stops                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The PIN only works on a **paired till**   | A PIN learned by watching over someone's shoulder is useless on the thief's own phone, or from home |
| The account **locks after 5 wrong tries** | Turns unlimited guessing into 5 tries per 15 minutes                                                |
| The PIN is **hashed with Argon2id**       | A stolen copy of the database does not hand over working PINs                                       |

Remove any one and the arrangement falls apart. That's why there are tests asserting each of them
separately.

### Why "tap your name, then the PIN" instead of just the PIN?

If the till only asked for a PIN, the server would have to work out _who_ typed it — which means
every cashier in the outlet would need a **different** PIN. That has two problems: it quietly tells
you when a PIN is already taken, and it caps how many cashiers you can have. Picking the name first
means two cashiers can both use 1234 and neither knows.

---

## 2. Tills that pair once

A brand-new tablet knows nothing. It cannot be allowed to simply declare itself a till — otherwise
a tablet that walks out of the building could keep taking orders.

So pairing takes **two people and two steps**:

1. A manager, already signed in, asks for a **pairing code** — eight characters, good for ten
   minutes, usable once.
2. Someone types that code into the tablet. The tablet gets a long-lived **device token** and
   remembers it.

Neither half is enough alone. A stolen tablet has no code; an overheard code is worthless ten
minutes later, and worthless immediately if already used.

Small details that matter:

- **The code alphabet excludes 0, O, 1, I, L and U.** It gets read aloud across a counter, and
  "was that a zero or an O?" is a support call.
- **Only the _hash_ of the code and token is stored**, never the values. A database leak yields
  nothing usable.
- **Revoking a till ends its sessions immediately** — a lost tablet stops working now, not in
  thirty days when its token would have expired.

---

## 3. Two kinds of hashing, for two kinds of secret

This surprises people, so it is worth spelling out. The system hashes things in two completely
different ways on purpose.

|           | Passwords and PINs                                                                                  | Device and refresh tokens                                                          |
| --------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Algorithm | **Argon2id**                                                                                        | **SHA-256**                                                                        |
| Speed     | Deliberately slow (~26 ms)                                                                          | Deliberately instant                                                               |
| Why       | A human picked it, so it might be guessable. Each guess must cost the attacker real time and memory | 256 bits of randomness. There is nothing to guess, so slowness would buy no safety |

Using the slow one for tokens would make every single request slow for no benefit. Using the fast
one for PINs would let an attacker with a stolen database try all 10,000 PINs in under a second.

### A subtle one: the fake check

When someone tries to sign in with an email that doesn't exist, the server **still spends ~26 ms
pretending to check a password**.

Without that, "no such account" would answer in microseconds while "wrong password" took 26 ms —
and anyone could use the difference to discover which email addresses are registered. The code for
this is called `verifyDummy`, and there is a test that fails if it ever becomes a no-op.

For the same reason, _every_ sign-in failure returns the identical message: **"Those sign-in
details are not correct."** Wrong password, unknown email, cashier trying the manager door — all
indistinguishable.

The one deliberate exception is a locked account, which says so plainly, including how long and
that a manager can reset it. A manager locked out mid-service needs to know why their correct
password is being refused.

---

## 4. Sessions that rotate, and catch theft

Signing in gives the till two tokens:

- An **access token** that lasts 15 minutes and proves who you are on each request.
- A **refresh token** that lasts 30 days and is used to get a new access token.

Why two? Because the access token is checked on every request and cannot be cancelled before it
expires. Keeping it short means a deactivated staff member stops working almost immediately. The
refresh token is long so the till doesn't log itself out mid-shift, and it is safe to be long
because it can be cancelled server-side at any moment.

### Rotation, and what happens on replay

**Every use of a refresh token issues a new one and kills the old one.** The old and new are linked
in a chain.

Now the interesting part. If a token that has **already been used** shows up again, one of two
things is true: the client is badly broken, or the token was stolen and is being replayed. The
server cannot tell which — so it assumes theft and **cancels every session for that person**.

That means an honest user with a buggy client gets logged out. We accept that: logging someone out
is a small annoyance, while leaving an attacker with a working session on a system that takes
payments is not.

There is a test for exactly this, and it also checks the thief's freshly-rotated token is dead too —
cancelling only the replayed one would leave the attacker in and kick the victim out, which is the
worst of both.

### One more detail

The POS client coalesces concurrent refreshes into a single request. Without that, two requests
expiring at the same moment would each try to rotate, the second would present a token the first
had just replaced, the server would correctly see that as theft — and the till would log itself out
for no reason. A "refresh stampede" logging out the whole restaurant is the kind of bug that only
appears under load.

---

## 5. The logbook (audit trail)

Every action that matters is recorded permanently: who, what, when, from which till, from which IP,
and whether it succeeded.

It reads like a story. This is real output from the running system:

```
SUCCESS auth.login.pin               Rahul Das
SUCCESS staff.pin.set                Vikram Shah   PIN set or reset; lockout cleared
DENIED  auth.login.locked            Rahul Das     auth.login.pin; attempt 5 of 5
FAILURE auth.login.failed            Rahul Das     auth.login.pin; attempt 4 of 5
FAILURE auth.login.failed            Rahul Das     auth.login.pin; attempt 3 of 5
SUCCESS device.pair                  -             paired with code created by staff fafc65d9…
SUCCESS device.pairing_code.create   Vikram Shah
SUCCESS auth.login.password          Vikram Shah
```

You can read that top to bottom and reconstruct the shift: a manager signed in, created a pairing
code, a till paired itself, a cashier fumbled their PIN until they were locked out, the manager
reset it, and the cashier got in.

Four design decisions behind it:

**It stores the actor's name as well as their id.** If it only stored the id, renaming or deleting
a staff member later would make the history unreadable — or worse, rewrite who did something.
Keeping a copy of the name as it was at the time means the past cannot be edited.

**It is append-only.** There is no endpoint to change or delete a row and there never will be. An
audit trail that can be edited is not an audit trail.

**Credentials are stripped automatically.** The log deliberately keeps a copy of what changed,
which makes it the easiest place in the whole system to accidentally store a password forever. So
anything that looks like a credential — any field whose name contains `password`, `pin`, `token`,
`secret`, `hash`, `authorization` or `cookie` — is replaced with `[redacted]` on the way in, at the
boundary, rather than relying on every caller to remember.

**A failed log write never fails the thing it was describing.** Refusing a sale because the logbook
is full would be worse than a gap in the logbook. (This flips in Step 7: records about _money_ will
be written inside the same transaction as the sale, so they succeed or fail together.)

Managers and owners can read it. **Cashiers cannot** — it is a record of staff behaviour, so
colleagues should not be reading each other's.

---

## 6. Locked by default

The authentication check is applied **globally**, to every endpoint, automatically. An endpoint is
closed unless it explicitly says `@Public()`.

This is the opposite of the usual arrangement, where you add a guard to each route that needs one.
The difference matters: with per-route guards, an endpoint added in a hurry is **wide open** and
nothing in the code says so. Here, forgetting leaves it **shut**. Forgetting is safe.

There are only a handful of public routes, and each one is obvious: sign in, redeem a pairing code,
refresh a session, and the two health probes.

Roles are also explicit, with **no hierarchy**. A route managers may use is written
`@Roles('OWNER', 'MANAGER')` — an owner is not silently granted everything. Implicit inheritance is
how an owner-only action quietly becomes manager-accessible six months later.

---

## What the screens look like now

A till is in exactly one of three states, and shows the matching screen:

1. **Unpaired** → "Pair this till", asking for the manager's code.
2. **Paired, nobody signed in** → the PIN pad: tap a name, enter a PIN.
3. **Signed in** → the POS, with a banner showing who is on the till, which till it is, which
   outlet, and a **Hand over** button for shift changes.

Those are two separate pieces of state on purpose. Signing out forgets the _person_ but keeps the
till paired — a shift change should not look like a fresh install.

Interface details chosen for a real counter: every touch target is at least 44px, the PIN pad
auto-submits on the sixth digit so nobody wonders whether the last tap registered, and a cashier
whose PIN was refused keeps their name selected rather than starting over.

---

## Three bugs the tests found

Worth recording, because each was invisible until something checked.

**1. The whole API was limited to 10 requests per minute.** I had set up two rate-limit buckets,
intending a tight one for sign-in and a generous one for everything else. But the library applies
_every_ bucket to _every_ route — so the tight limit silently applied everywhere. The POS would
have been unusable in production: the status indicator alone polls four times a minute. Caught by a
test asserting health probes are never throttled.

**2. Money could hold negative zero** (found in the Step 1 review). Harmless to arithmetic, but it
would have printed a refund line as "-₹0.00".

**3. The POS discarded the details of a failed health check.** When the database was down, the
screen said "degraded" but never showed _which_ dependency failed or why — the most useful fact.

---

## Numbers

|                 | Step 1 | Step 2    |
| --------------- | ------ | --------- |
| Tests           | 222    | **463**   |
| Line coverage   | 99.9%  | **97.5%** |
| Database tables | 2      | **7**     |
| API endpoints   | 2      | **15**    |

---

## What we deliberately did _not_ build

- **No password reset by email.** There is no email infrastructure until Step 10. A manager resets
  a cashier's PIN; an owner resets a manager's password. For a single-outlet restaurant that is the
  realistic path anyway.
- **No two-factor authentication.** Reasonable for a head-office admin panel; wrong for a counter
  terminal mid-service.
- **No "remember me on this browser".** The till remembers itself; people do not.
- **No self-service staff screens.** Managers administer staff; staff do not edit themselves.

---

## Up next: Step 3

Menu management. Categories, items, half/full variants, modifier groups ("extra cheese", "no
onion"), GST tax classes, and the availability toggle a manager hits when the paneer runs out.
That's the first step where the restaurant owner starts entering their own real data.
