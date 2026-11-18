# convex/

This directory is the entire Chop backend. It runs on [Convex](https://convex.dev) — a serverless TypeScript platform that provides the database, functions, file storage, and HTTP endpoints in one place.

---

## Running locally

```bash
# From the workspace root
pnpm dev:backend
```

This starts the Convex dev server and hot-reloads any file changed under `convex/`. Generated types are written to `convex/_generated/` automatically.

## Deploying to production

```bash
npx convex deploy --prod
```

---

## File map

| File | Purpose |
|---|---|
| `schema.ts` | Full database schema — all tables and indexes |
| `auth.ts` | Auth providers: Google OAuth + Password with Resend OTP reset |
| `auth.config.ts` | Convex Auth domain config (reads `CONVEX_SITE_URL`) |
| `http.ts` | HTTP router — mounts auth routes + the two Paga callbacks |
| `http_actions.ts` | `pagaCheckoutCallback` / `pagaTransferCallback` — SHA-512 hash-verified Paga callbacks |
| `sessions.ts` | Session CRUD, fee computation, slug generation |
| `participants.ts` | Participant queries, `updateParticipantStatus` (webhook path), `demoMarkPaid` |
| `payments.ts` | `initiateCheckout` action — builds a Paga Checkout payment link; `confirmCheckoutPayment` applies the callback |
| `paga.ts` | Shared Paga helpers — base URLs, hashing, references, response-code classification |
| `pagaApi.ts` | Paga Business API client (Node runtime, optional fixed-IP proxy) — banks, validate, deposit, status |
| `payouts.ts` | `listBanks`, `resolveAccount`, `requestPayout` actions; internal payout helpers |
| `notifications.ts` | Notification queries and mutations |
| `users.ts` | Profile read, avatar upload URL generation, profile update |

---

## Data model

### `sessions`
A "chop" session created by an organizer.

- `mode` — `"food"` | `"bill"` | `"chop-in"`
- `status` — `"active"` → `"closed"` → `"inactive"`
- `slug` — public URL identifier, format `CH-XXXXXXXX`
- All money fields in **kobo** (integer, never float)
- `feePerParticipant` — flat fee added to each participant's owed amount (food/bill)
- `feePercent` — percentage fee deducted at payout time (chop-in, currently 10%)

### `participants`
One row per person in a session.

- `status` — `"pending"` (not yet paid) | `"sent"` (payment confirmed)
- `amountOwed` — computed at session creation and stored; not re-derived on read
- `paymentRef` — the `CHP-…` checkout reference, set by the Paga checkout callback
- `items` — food mode only: line items assigned to this participant

### `payouts`
One row per payout request made by an organizer.

- `status` — `"pending"` | `"processing"` | `"completed"` | `"failed"` | `"processed"` (legacy)
- `reference` — the `CPO-…` Paga `referenceNumber`; claimed before any money moves and never regenerated
- `bankCode` — Paga bank UUID; `pagaTransactionId` — Paga's short transaction ID

### `checkouts`
One row per Paga Checkout attempt: `reference` → `participantId` + the `amountKobo` we asked Paga to charge.

### `notifications`
In-app notifications for session organizers. Types: `"payment"` and `"session_closed"`.

### `users`
Extended from Convex Auth's built-in user table. Extra fields: `firstName`, `lastName`. `image` stores either a Google profile URL or a Convex Storage ID (resolved to a URL in `getMyProfile`).

---

## Payment flow

```
Browser → initiateCheckout action
        → records checkouts row, builds Paga Checkout payment link
        → redirect user to checkout.paga.com
        → Paga returns user to /payment-success (charge_url) with status_code

Paga → POST /paga/checkout-callback
     → sha512(amount + timeStamp + paymentReference + hashKey) verified
     → confirmCheckoutPayment: amount check → markParticipantPaid → (auto-close if all paid)

Organizer → requestPayout action
          → validateDepositToBank → claimPayout (atomic guard + "pending" row)
          → depositToBank → "processing" | "failed" | stays "pending" (unknown → status checks)

Paga → POST /paga/transfer-callback (x-paga-hash header)
     → completePayout (session → inactive) | failPayout | checkPayoutStatus
```

### Chop In pre-insertion pattern
For chop-in sessions, a `"pending"` participant row is inserted **before** the Paga redirect (`reserveChopInParticipant`) so the callback has a stable ID to act on. If the user abandons payment the row stays pending harmlessly.

---

## Fee structure

**Food / Bill** — tiered flat fee split equally across participants, baked into `amountOwed` at creation:

| Session total | Total fee |
|---|---|
| < ₦5,000 | ₦100 |
| < ₦10,000 | ₦150 |
| < ₦20,000 | ₦200 |
| < ₦50,000 | 0.75% |
| ₦50,000+ | 0.5% |

**Chop In** — 10% deducted from collected total at the point of payout withdrawal.

---

## Paga API notes

- Docs: https://developer-docs.paga.com — base URLs switch on `PAGA_ENV === "live"` (sandbox otherwise)
- Every request is signed: `hash` header = SHA-512 of the operation's fields in order + `PAGA_HASH_KEY`
- Paga only accepts API calls from **whitelisted IPs**. Convex has no static egress IP, so Business API
  calls go through `PAGA_PROXY_URL` when set. Checkout itself runs in the payer's browser and needs no whitelist.
- Money amounts are **decimal naira strings** e.g. `"750.00"` — convert: `(kobo / 100).toFixed(2)`
- Payout response codes: `0` success, `3` pending, `-1`/`105`/`135`/timeouts **unknown** — check
  `transactionStatus` with the same reference, never resend with a new one (see `classifyPagaResponseCode`)

---

## Required environment variables

Set these in the [Convex dashboard](https://dashboard.convex.dev) under your deployment's Settings → Environment Variables.

| Variable | Purpose |
|---|---|
| `CONVEX_SITE_URL` | Full URL of the frontend, used as the auth domain |
| `SITE_URL` | Same as above (used by `@convex-dev/auth` internally) |
| `JWT_PRIVATE_KEY` | RSA private key for signing JWTs |
| `JWKS` | Matching public key set (JSON) |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `AUTH_RESEND_KEY` | Resend API key (`re_...`) for OTP emails |
| `AUTH_EMAIL_FROM` | Verified sender address e.g. `Chops <noreply@yourdomain.com>` |
| `PAGA_PUBLIC_KEY` | Paga public key (Developer Tools → API Keys) |
| `PAGA_SECRET_KEY` | Paga secret key |
| `PAGA_HASH_KEY` | Paga hash key — signs requests and verifies callbacks |
| `PAGA_ENV` | `"live"` for live Paga; omit for sandbox |
| `PAGA_RELAY_URL` / `PAGA_RELAY_SECRET` | Dev — route Business API calls through the Vite dev server relay (`https://<ngrok-domain>/paga-relay`); the secret must match `PAGA_RELAY_SECRET` in `frontend/.env.local` |
| `PAGA_PROXY_URL` | Optional — `http://user:pass@host:port` of a proxy whose IP is whitelisted with Paga |
