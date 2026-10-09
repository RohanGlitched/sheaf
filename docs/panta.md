## Panta

Every Sheaf basket carries one prediction market, run on [Panta](https://panta.market): **"Will {basket} ({symbol}) beat SPY this week?"**

The market resolves from a number anyone can recompute from chain state: one share's value, read from its vault, against SPY's close-to-close change. Sheaf publishes that number as JSON at `/api/nav/<basket>` and names it as the market's first source of truth. Nobody has to trust Sheaf's price.

"Powered by Panta", linked to panta.market, appears on every Panta module: the basket page panel (twice), `/predict` and `/portfolio`.

### Endpoint → product mapping

| Panta product | Endpoint | Where in Sheaf |
|---|---|---|
| Discovery | `GET /markets/`, `GET /categories/` | Basket pages, `/predict` (`GET /api/panta`) |
| Data | `GET /markets/{id}/`, `GET /markets/{id}/trades/` | Position values on `/portfolio` (`GET /api/panta/positions`) |
| Creation: quote | `POST /markets/create/quote/` | Basket page, "Open it on Panta", step 1; `/predict` fee |
| Creation: build | `POST /markets/create/build/` | Step 2 |
| Creation: sign | the wallet's `signTransaction` (never sent) | Step 3 |
| Creation: register | `POST /markets/register/` | Step 4 |
| Trading: quote | `POST /primaryorderquote/` | Basket page, "Take a side", step 1 |
| Trading: build | `POST /primaryorderbuild/` | Step 2 |
| Trading: sign | the wallet's `signTransaction` (never sent) | Step 3 |
| Trading: submit | `POST /primaryordersubmit/` | Step 4 |
| Trading: verify | `POST /primaryorderverify/` | Step 5 |
| Attribution | `POST /trades/` | Step 6, and after a win claim |
| Positions | `GET /positions/?wallet=` | `/portfolio`, "Predictions" |
| Win claims | `POST /claim/build/`, then sign, then `POST /trades/` | `/portfolio`, "Predictions" |
| Creator fees | `POST /claim/creator-fees/build/` | Basket page, "Creator fees" |

Each step in the UI names the endpoint it calls and shows the fields Panta actually returned: `createId`, `expectedEventPda`, `orderId`, instruction count, blockhash and status.

The market Sheaf drafts includes:
- `category`: finance when Panta offers it (it does live); the sandbox lists none, so the sandbox falls back to crypto
- `sourcesOfTruth`: the NAV JSON, the basket page, and SPY on Nasdaq
- `imageUrl`: a 1024×1024 PNG at `/api/panta/image/<basket>`, the basket's sheaf drawing under its question

Code:
- `web/lib/panta-server.ts`: every Panta call; holds the key.
- `web/app/api/panta/route.ts`: one `kind` per step.
- `web/app/api/panta/positions/route.ts`
- `web/app/api/panta/image/[address]/route.tsx`
- `web/app/api/nav/[address]/route.ts`
- `web/lib/panta-throttle.ts`
- `web/lib/panta-sign.ts`: compiles transactions for the wallet.
- `web/lib/panta-client.ts`
- `web/components/basket-predict.tsx`
- `web/components/panta-steps.tsx`
- `web/components/panta-positions.tsx`
- `web/components/predict-index.tsx`
- `web/app/predict/page.tsx`

### Why sandbox

Opening a market on Panta costs about 50 USDC (`paymentUsdc: 50000000`) plus SOL, and Sheaf spends no real money. A `pk_test_` key runs the identical flow against Panta's sandbox: the same endpoints and request bodies, with fixed fixture answers and nothing on mainnet.

The UI tags every fixture value as "sandbox fixture" (Panta marks these answers with a `disclaimer` field). Three cases matter:
- **Buy quotes.** The sandbox answers every buy with the same fixed quote, "$1.00 buys 2.00 shares". The panel shows the amount you asked for next to Panta's answer and says the answer is fixed.
- **The market.** The sandbox has one fixture market, "Sandbox test market". It is labelled as standing in for the basket's market, never shown as if it were the basket's own.
- **Signing.** Sandbox builds return an empty transaction, no instructions, and a placeholder blockhash. Sheaf then compiles a memo-only stand-in on a fresh devnet blockhash, asks the wallet to sign it, and says so. The signed transaction is never sent anywhere. If a wallet declines, the sandbox flow can continue with a clearly labelled placeholder signature.

`POST /api/panta` has two throttles: 20 requests a minute per IP, and per-kind caps below Panta's own account limits (24 quotes, 16 builds, 30 reports and 90 reads a minute). Identical create quotes are reused for 60 s. In the sandbox, a buy or claim must name a market in Panta's catalog.

### What changes for live

Only the key changes:

```bash
PANTA_API_KEY=pk_live_...   # was pk_test_...
```

With a live key:
- Discovery, data, positions and quotes read Panta's mainnet catalog.
- The draft files under finance.
- `lib/panta-server.ts` refuses every build, register, submit, verify, report and claim step with `403 SHEAF_SANDBOX_ONLY`. Sheaf stops at the quote, so a live deployment cannot move USDC by accident. Removing that guard is a deliberate code change.

For a real sponsored market, the steps already in place carry over unchanged:
- The wallet signs Panta's own transaction (base64 `VersionedTransaction` for create; an instruction list compiled to v0 for buy and claim), which the user broadcasts.
- Register and submit then receive the real signature, which Panta verifies on chain.

### Try it

```bash
curl -s https://sheaf-index.vercel.app/api/panta | jq '{mode, fixture, category}'
curl -s https://sheaf-index.vercel.app/api/nav/FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ | jq '{question, navPerShare, week}'
```
