## Solami

Sheaf reads Solana mainnet through [Solami](https://solami.dev). Solami supplies two things: a live tape of tokenized-stock trades, and every xStock's Token-2022 dividend multiplier, which sets basket NAV.

### What Sheaf uses, exactly

Sheaf uses one Solami product: the **RPC** (`https://rpc.solami.dev/solana?api-key=…`), on the free tier. It does not use WebSocket, gRPC, Webhooks or the Data API.

| Route | Solami RPC methods | Cadence | What it is for |
|---|---|---|---|
| `GET /api/tape` | `getSlot`, `getSignaturesForAddress` (2 mints per poll, rotating through 10), `getTransaction` (up to 3 that just landed plus up to 3 from the backfill queue per poll, `maxSupportedTransactionVersion: 1`), `getBlockTime` (at most 1 per poll) | One poll at most every 3 s per server instance, plus 2 s of CDN cache | The home page tape: who bought or sold which stock token, at what fill price, through which venue |
| `GET /api/tape` (first poll of an instance) | `getSignaturesForAddress` with `limit: 20` on all 10 mints, then the newest 8 decoded | Once per cold instance | The backfill, so a new instance is not empty |
| `GET /api/tape` (comparison strip) | `getSlot` sent to Solami and the public RPC at the same instant, 1 warm-up pair plus 5 measured pairs; `getTransaction` on both for the newest signature, if it landed in the last ~30 s | Once a minute | The "Solami vs public" figures shown on the page |
| `GET /api/market` | `getMultipleAccounts` over all 28 mints, in one call | Each 10 s of CDN cache | Each mint's Token-2022 `ScaledUiAmount` multiplier and supply. These value every basket. |
| `GET /api/nav/<basket>` | The same `getMultipleAccounts` read (cached 15 s) | On request, 30 s CDN cache | The JSON NAV that a basket's Panta market resolves from |

Code:
- `web/lib/solami.ts`: the client, with pacing, 429 handling and the fallback.
- `web/lib/tape-server.ts` and `web/app/api/tape/route.ts`: the tape.
- `web/lib/mainnet.ts`: the mint multipliers.
- `web/components/live-tape.tsx`: the page.
- `scripts/tape-seed.mjs` and `web/public/tape.seed.json`: the earlier-trades seed.

### What the tape decodes

From each transaction's pre and post token balances, Sheaf works out three things:
- **The pool**: the account that gave up or took in the most stock, and was paid the opposite way in USDC, USDT or SOL.
- **The side**: from the fee payer's change. A payer that ended flat in both the stock and dollars is labelled `Arb`.
- **The fill price**: the pool's quote leg divided by the stock leg.

The page then:
- multiplies the raw amount by the mint's dividend multiplier, so the price is per UI token
- shows the fill against Jupiter's price for the same token
- tags the venue from the program ids in the transaction (Jupiter, Meteora, Raydium, Orca and others)

Rows are filtered out in these cases:
- worth less than $1, or under 0.0001 tokens (dust)
- not a trade: stock moved but no pool was paid the other way and no swap program ran (a wallet-to-wallet transfer, a mint, a vault deposit). These used to show as "Moved"; they are now dropped.
- a fill more than 15% away from Jupiter's price, which is treated as a mis-decode of a multi-leg route; the trade is still listed, without a price

The tape is a sample: the newest trades on two of ten mints per poll, not every fill.

### Cold starts: backfill and seed

A new serverless instance starts with nothing in memory. Two things keep the tape from sitting empty:

- **Backfill.** An instance's first poll reads the last 20 signatures on every watched mint (ten paced calls) and decodes the newest eight. The rest wait in a queue (at most 80), and while the tape has fewer than 30 rows each later poll decodes two or three of them alongside the new trades. `backlog` in the response says how many are still queued. Backfilled rows are real chain reads with real block times, but they carry `live: false`.
- **Seed.** `web/public/tape.seed.json` holds 40 real trades captured earlier by `scripts/tape-seed.mjs`, which polls a running Sheaf server's `/api/tape?depth=60` (the same decoder and filters) and stores Jupiter's price and the dividend multiplier at capture time with each row. The page shows them at once, under an "Earlier trades, not live" divider with the capture time, until eight rows have come from the server. Seed rows show their real block times, compare their fill with Jupiter's price at capture, are never highlighted, and never feed the latency figures.

  ```bash
  node scripts/tape-seed.mjs                         # against http://localhost:3900
  node scripts/tape-seed.mjs https://sheaf-index.vercel.app 40
  ```

A row is `live: true` only when it landed after the server last read its mint. Only those rows, with a block time from the chain, count toward "block to this screen".

### Serverless: `after()`

`/api/tape` answers from the cached tape when it is 3 to 30 s old and starts the next poll behind the response. The route hands that poll to Next's `after()` (from `next/server`), so on Vercel the function stays alive until the poll finishes. A bare un-awaited promise would be frozen as soon as the response was sent, and the cache would never refresh. A tape older than 30 s (or none) is polled while the caller waits.

Times come from the block. Solami answers `blockTime: 0` at `confirmed` commitment, so Sheaf makes one `getBlockTime` call on the newest fresh slot and places nearby slots by slot distance (about 0.4 s a slot). Placed times show with a `~`. The tape never shows "now" for an unknown time.

### Setup and your own key

1. Sign up at [solami.dev](https://solami.dev). The free tier needs no card.
2. Copy the API key into `web/.env.local`:

   ```bash
   SOLAMI_API_KEY=your-key   # server-side only; never sent to the browser
   # Optional: the endpoint used when Solami is unset or failing
   # NEXT_PUBLIC_MAINNET_RPC=https://api.mainnet-beta.solana.com
   ```
3. Start the app with `pnpm dev` in `web/`, then open `/`, or call `/api/tape`.

Without a key, everything still works through the public mainnet RPC, and the page says "read through a public RPC".

### Staying inside the free tier (5 requests a second)

A burst past the limit answers `429` with `Retry-After: 1`. The free tier is 5 requests a second, and Sheaf stays under it in five ways:

- **Paced calls.** Every Solami call goes through one queue per server instance in `lib/solami.ts`, at least 240 ms apart (about 4.2 a second). A tape poll sends its calls one after another, never in parallel. The `/api/market` read uses the same queue through a paced `fetch` handed to `@solana/web3.js`, so it shares the budget with the tape.
- **Shared caching.**
  - A poll answers every visitor for 3 s.
  - A tape up to 30 s old answers at once while the next poll runs behind it, in `after()`.
  - `/api/tape` sends `cache-control: public, s-maxage=2, stale-while-revalidate=10`, so the CDN coalesces every open tab into at most one request every couple of seconds.
- **429 handling.** A 429 waits out its `Retry-After` (capped at 2 s) and retries once. If it fails again, Solami goes on an 8 s cool-down, and the public RPC answers in the meantime.
- **Honest `via`.** `via` names the RPC that actually answered the poll. When the public RPC stood in for Solami, `fallback` gives the reason, and the page prints it. A `getSlot` failure no longer turns the response into a 502: the poll carries on, and if the whole poll fails, the last good tape is returned with `stale: true`.
- **No wasted retries.** An error about one request (for example, an unsupported transaction version) is not treated as an outage. That signature is skipped, and Solami is not put on cool-down.

On the client, `live-tape.tsx` merges new prints into what is already on screen and keeps a rolling 40. A poll answered by a cold serverless instance cannot thin the list, and a failed poll leaves the last good tape in place.

### Proof that the answers come from Solami

```bash
curl -s https://sheaf-index.vercel.app/api/tape | jq '{slot, via, fallback, stale, backlog, proof}'
```

A real answer from a local dev server on Oct 9, 2026:

```json
{
  "slot": 454799612,
  "via": "solami",
  "fallback": null,
  "stale": false,
  "backlog": 78,
  "proof": {
    "rpcMs": 167,
    "compare": {
      "slot": {
        "method": "getSlot", "commitment": "confirmed", "samples": 5,
        "solami": { "medianMs": 174, "slot": 454799566, "answered": 5, "rateLimited": 0 },
        "public": { "medianMs": 64, "slot": 454799565, "answered": 5, "rateLimited": 0 },
        "slotLead": 1,
        "at": 1791531012200
      },
      "freshTx": { "tried": 1, "solami": 1, "public": 1 },
      "upstreams": {
        "solami": { "calls": 109, "ok": 109, "rateLimited": 0, "failed": 0 },
        "public": { "calls": 13, "ok": 13, "rateLimited": 0, "failed": 0 }
      }
    },
    "calls": 9,
    "pollMs": 2091
  }
}
```

- `via` is `"solami"` only when Solami answered that poll's reads. It reports the answer, not the presence of a key.
- `proof.rpcMs` is that poll's `getSlot` round trip.
- `proof.compare` is the Solami-vs-public comparison, described below.
- Each print carries `live`: true only when it landed after the server last read its mint.

### How the Solami-vs-public comparison is measured

The old figure was one `getSlot` to each upstream, back to back, every 30 s. It mixed a cold TLS handshake into one side and gave whichever went second a later slot, so it said little. It is now measured like this, once a minute:

- **Same call, same moment.** `getSlot` at `confirmed` goes to Solami and to the public RPC (`NEXT_PUBLIC_MAINNET_RPC`, default `api.mainnet-beta.solana.com`) in parallel, as a pair.
- **Warm connections.** The first pair opens the keep-alive sockets and is thrown away. Five more pairs follow.
- **Median, not a single sample.** `medianMs` is the median round trip of the samples each side answered.
- **Freshness.** `slotLead` is the median of Solami's slot minus the public RPC's slot within each pair. Positive means Solami was further along the chain.
- **Just-landed transactions.** When the newest signature the poll read landed in the last ~30 s, both upstreams are asked for it at the same instant. `freshTx` counts how often each one returned it rather than null. The signature comes from Solami's own `getSignaturesForAddress`, which favours Solami, so read it as "can the public RPC serve what just landed", not as a neutral race.
- **Reliability.** `upstreams` counts every call this server instance sent to each upstream, and how many were rate-limited (429) or failed.

The page prints the figures as they come, plus one sentence saying which was faster. In our runs from the dev machine, **the public RPC was faster on raw round trip** (about 60 to 110 ms median against Solami's 170). Solami was **one slot ahead** at the same instant, **rate-limited none** of 100+ calls at the tape's paced rate, and served every just-landed transaction we asked for (so did the public RPC, over a small sample). The page says this plainly whichever way it goes, and the numbers on Vercel will differ with the region. What the public RPC does not offer is the budget: Solana documents it as not meant for production apps, at 100 requests per 10 s per IP and 40 for any single method, shared with everyone on the same IP.

The home page also shows "block to this screen": the median, over the last 15 live trades, of the time from the trade's block time to the moment the row reached the browser. It includes the rotation (each mint is read every fifth poll), so it is the honest end-to-end figure, not the RPC's latency.

```bash
curl -s https://sheaf-index.vercel.app/api/market | jq .chain
# {"slot":454781334,"via":"solami"}
```

Each row on the tape links to Solscan, so any trade can be checked against the chain.

### Limits, stated plainly

- Free tier only: polling plus caching, with no WebSocket or gRPC. The site runs live on the free tier, without the Pro trial.
- The tape samples the newest trades on 10 mints; it does not capture every fill.
- Fill prices are decoded from balance changes. Multi-leg routes can mis-decode, and those rows show no price.
