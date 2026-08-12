# angelfish

Uniswap **v3 + v4** ETH-pair swap indexer for **Ethereum mainnet**.

It sweeps Swap logs in a rolling block window, works out which pools are ETH-paired,
aggregates per-token trading activity, prices each token on-chain, and ranks the
result into a Top Movers board plus a Danger Zone board for anything below the
market-cap gate.

This is a port of the Robinhood-chain movers boards in `node/personal/worker/nautilus`
(`src/robinhood/**`). The method is deliberately the same; the differences are all
consequences of mainnet, and every one of them is listed under
[Mainnet deviations](#mainnet-deviations) below.

## Quick start

```bash
npm install
cp .env.example .env      # RPC defaults work as-is
npm run chat-id           # optional: discover the Telegram chat to post to
npm run once              # one cycle, prints (and posts) both boards
npm run dev               # poll forever
npm test
```

## The method

Both versions run the same seven steps. Only steps 1–3 differ between v3 and v4.

| # | Step | v3 | v4 |
|---|------|----|----|
| 1 | **Find the swaps** | `eth_getLogs` on the v3 Swap `topic0`, **no address filter** — the pool set is discovered from the logs, so a brand-new pool is visible on its first trade | `eth_getLogs` filtered to the **PoolManager singleton** + v4 Swap `topic0`; every v4 pool trades through that one contract |
| 2 | **Identify the pool** | `token0()` / `token1()` / `fee()` on the pool address, then a **factory check** | v4 pools aren't contracts — a `bytes32` PoolId is `keccak256(PoolKey)`, one-way — so the key is read from `PositionManager.poolKeys(bytes25)`, with `Initialize` logs from the same window folded in |
| 3 | **Keep the ETH pairs** | one side must be WETH | one side must be WETH **or native ETH** (`address(0)`) |
| 4 | **Aggregate the window** | Σ\|ETH-leg amount\| as volume, unique swappers as traders, fee = tier × input side | same, except the fee **charged on each swap arrives in the event**, so dynamic-fee pools value correctly with no extra call |
| 5 | **Record a candle** | last `sqrtPriceX96` of the window → a 5-minute (25-block) bucket, forward-filled across tradeless buckets, feeding RSI-14 | same |
| 6 | **Price the token** | FDV = `totalSupply × price-in-pool × ETH/USD`, with ETH/USD read from the USDC/WETH 0.05% pool's `slot0` | same |
| 7 | **Split the board** | ≥ `$300k` FDV → main board; below, or unknown → **Danger Zone** | same |

Two properties carry over from nautilus and are worth stating explicitly, because
they are what make the boards trustworthy rather than merely populated:

- **Fee valuation and market cap are computed from the pool the token actually
  trades in**, never from an external price API. One `slot0` read on the USDC/WETH
  pool prices every row on the board.
- **Every "unknown" fails safe.** An unreadable market cap is not evidence of a
  qualifying one, so the row lands in Danger Zone. A transient RPC failure is never
  cached as a negative verdict — only a *confirmed* one is.

### Caching

Nothing is looked up twice if it can be helped, and each cache expires on the
timescale of the thing it holds:

| Cache | Keyed by | Expiry | Why |
|-------|----------|--------|-----|
| v3 pool meta | pool address | permanent | `token0/token1/fee` are immutable |
| v4 pool key | PoolId | permanent when found, 24h when not | a `PoolKey` is immutable; an unresolved id might just not have been seen yet |
| token supply + decimals | token | 1 hour | `totalSupply()` is **not** immutable — a mint should move the cap |
| verification + audit | token | permanent when verified, 6h when not | source can't be un-verified, but an unverified token gets verified later |
| symbol | token | permanent | — |

State persists to `tmp/movers-v3.json` and `tmp/movers-v4.json`, so a restart
resumes the block cursor rather than replaying.

## Mainnet deviations

These are the places the port is **not** a rename. Each one is also commented at
the code site.

### 1. `eth_getLogs` is range-capped — chunk up front (`mainnet/rpc.ts`)

Free mainnet endpoints cap the block span hard. blastapi answers a 1000-block query
with:

```
-32600 "You can make eth_getLogs requests with up to a 10 block range"
```

nautilus copes by **bisecting after rejection**, which spends a rejected round-trip
at every level of the recursion — from a 300-block window down to 10, ~31 wasted
calls per sweep. Here the range is chunked to `ETH_MAX_LOG_RANGE` (default 10)
*before* the request. The reactive bisection is kept as a backstop, because some
providers cap on **result count** instead, which chunking can't predict.

Raise `ETH_MAX_LOG_RANGE` on a paid endpoint; every increase is one fewer
round-trip per cycle.

### 2. Not every RPC allows the v3 sweep at all

The v3 sweep is topic-only by design (that's what makes new pools self-discovering),
and some endpoints refuse those outright. Measured 2026-08-13:

| Endpoint | Topic-only `eth_getLogs` |
|---|---|
| `eth-mainnet.public.blastapi.io` | ✅ (10-block cap) — the default |
| `eth.drpc.org` | ✅ (10-block cap, needs a browser `User-Agent` or it 403s) |
| `ethereum-rpc.publicnode.com` | ❌ `-32701 "Please specify an address in your request"` |
| `eth.merkle.io` | ❌ method not found |

### 3. v3 forks emit the identical Swap event — ask the factory (`mainnet/v3/metadata.ts`)

On the Robinhood chain there is one Uniswap deployment, so any contract answering
`token0()/token1()/fee()` with a WETH pair can be taken at its word. Mainnet has a
long tail of byte-identical v3 forks (SushiSwap v3 and others) emitting the **same**
`topic0` with the **same** ABI. The unfiltered sweep picks them up and nothing
downstream can tell them apart.

So each new pool is checked against the canonical factory:
`getPool(token0, token1, fee) == pool`. One extra `eth_call`, once, cached alongside
reads already being made. A *failed* verification call is deliberately **not** cached
— a timeout must not blacklist a genuine pool for the life of the process.

### 4. v4 pool metadata: `poolKeys`, not a full `Initialize` scan (`mainnet/v4/metadata.ts`)

This is the largest redesign. nautilus resolves a PoolId by scanning
`Initialize` logs from block 1 to head, filtered on that id. On mainnet that range is
over 4 million blocks (PoolManager deployed at **21,688,329** — verified by
`eth_getCode` being empty at 21,688,328 and 48,020 bytes at 21,688,329), and at a
10-block cap it would cost **~400,000 requests per unknown pool**.

Instead the PoolKey is read back from `PositionManager.poolKeys(bytes25)`, the
mapping v4 maintains for exactly this purpose. One `eth_call`, no range to negotiate,
works for a pool of any age. Measured on a live 9-block window: **50 of 52** PoolIds
resolved. The remaining two are pools initialized directly on the PoolManager rather
than through PositionManager; those are covered by folding each window's `Initialize`
logs into the registry as they happen, and otherwise expire under a 24h negative TTL.

Two traps this path has to avoid, both covered by tests:

- The id is passed as **`bytes25`, which is left-aligned** — high 25 bytes kept, low
  7 zeroed. Right-aligning it (the ordinary integer convention) reads the wrong
  mapping slot and returns an empty key, indistinguishable from "unknown pool".
- An empty key can't be detected by a zero `currency0`, because **`address(0)` is
  legitimate** — it's how v4 represents native ETH. Emptiness is judged on
  `tickSpacing`, which every real PoolKey has non-zero.

### 5. USDC replaces USDG as the USD anchor

ETH/USD comes from the **USDC/WETH 0.05% pool** (`0x88e6…5640`, confirmed via
`factory.getPool(USDC, WETH, 500)`). Its `token0` ordering is read from the pool
rather than hardcoded, so repointing `ETH_USDC_WETH_POOL` can't silently invert the
rate.

### 6. Block cadence retuned for ~12s blocks

`BLOCKS_PER_CANDLE` 2970 → **25** (both ≈ 5 min) and `MAX_LOOKBACK_BLOCKS` 6000 →
**300** (both ≈ 1 h). `MOVERS_POLL_SECONDS` 60 → **120**, because a measured cycle is
~73s warm on the free endpoint and a 60s interval would fire mid-cycle every time.

### 7. Telegram transport is dependency-free and dispatched from `index.ts`

nautilus posts each board to its own forum topic through `node-telegram-bot-api`,
called from inside each worker. Here only `sendMessage` is needed (no long-polling,
no command handling), so `telegram/sender.ts` talks to the Bot API over `fetch` with
no dependency at all.

The call site moved too: the workers return `{ main, danger }` and know nothing about
where the rows go — `index.ts` renders them to stdout **and** posts them. That keeps
the indexing path transport-agnostic and means a send failure can't reach the code
that advances the block cursor.

Forum topics are optional. nautilus posts each of its boards to a dedicated topic; if
`V3_MOVERS_TOPIC_ID` / `V4_MOVERS_TOPIC_ID` / `DANGER_ZONE_TOPIC_ID` are unset here,
everything goes to the chat's General topic, which is what an ordinary group wants.

## Telegram setup

A bot cannot open a conversation — the chat has to reach it first. So:

```bash
npm run chat-id      # starts listening
```

then send `/start` to the bot (or add it to a group and post anything there). The
script writes `TELEGRAM_CHAT_ID` into `.env`, and the next run posts.

Run the indexer without posting at any time with `TELEGRAM_ENABLED=0`. If the token
is present but the chat id is not, the process logs one warning and keeps printing
boards to stdout rather than failing.

Two send-path behaviours worth knowing:

- A **429 is retried for exactly as long as Telegram asks** (`parameters.retry_after`).
  Guessing a backoff instead of honouring it is what turns a brief flood-wait into a
  banned token.
- A board that would exceed Telegram's 4096-character limit **drops whole rows** from
  the tail. Cutting the text instead would sever an HTML tag, and Telegram rejects an
  unparseable body outright — costing the entire board rather than its last row.

## Reading a row

```
🥇 USDC ✅🔴 (0.01%) · RSI — · MC $49.9B
    Ξ15.65 vol · 20 swaps · 15 traders · Ξ0.0016 fees
    ↳ 0xa0b8…eb48
```

Line 1 is identity and signals, line 2 is activity in the window, line 3 is the
contract — **the contract address is the source of truth**, a symbol is not unique.

The two badges answer two different questions and are kept separate on purpose:
`✅`/`⚠️` is *can we see the source*, and `🟢🟡🔴⬜` is *what does the source do*.
`✅🔴` ("public and dangerous") and `⚠️⬜` ("we can't see it at all") are very
different situations.

> **Calibration note.** The risk heuristic is inherited from nautilus, where it was
> tuned against memecoin launches. On mainnet blue-chips it fires on things that are
> normal for them: USDC and USDT come back `✅🔴` because they genuinely are
> upgradeable proxies with a `mint` function. The verdict is *correct* per the rules;
> it is the rules that are calibrated for a different population. Treat 🔴 on an
> established token as "read the flags", not "rug". Retuning it for mainnet — a
> known-template allowlist, or splitting "upgradeable" from "owner can mint to
> anyone" — is the obvious next piece of work and is not done here.

`MC` is fully-diluted (total supply × price), not circulating.

## Layout

```
src/
  index.ts                  cycle loop; renders to stdout and posts to Telegram
  env.ts                    zero-dependency .env loader (must be imported first)
  engine/rsi.ts             Wilder's RSI
  types.ts                  MoversRow / MoversBoard, shared by both versions
  mainnet/
    config.ts               every mainnet constant, each verified live
    rpc.ts                  JSON-RPC: timeout, retry, proactive range chunking
    decode.ts               ABI word/address helpers + v3 Swap decoder
    price.ts  candles.ts  rsi-tag.ts     price series → 5-min candles → RSI
    onchain-mcap.ts         supply/decimals reads + the FDV formula
    eth-price.ts            ETH/USD from the USDC/WETH pool
    mcap-select.ts          lazy market-cap walk → main / danger split
    audit.ts                explorer verification + heuristic source scan
    format.ts               board rendering
    v3/  swaps · metadata · state · worker
    v4/  decode · swaps · metadata · state · worker
  telegram/
    format.ts               HTML boards with clickable explorer links
    sender.ts               Bot API sendMessage over fetch, no dependency
    chat-id.ts              `npm run chat-id` — discovers the chat to post to
```

## Known limits

- **RPC-call-bound.** A cold cycle is ~78s (v3) and ~38s (v4) on the free endpoint;
  warm, ~50s and ~23s. Almost all of it is sequential `eth_call` latency at ~330ms
  each. JSON-RPC **batching** would collapse each pool's `token0`/`token1`/`fee`/
  `getPool` into a single request and is the highest-value optimisation available;
  it is not implemented here.
- **The market-cap lookup ceiling is reached routinely.** A mainnet window holds
  ~30 pools against a default `MOVERS_MCAP_MAX_LOOKUPS=25`, so the walk is often
  cut short — which is logged, loudly, and means the board can be incomplete.
- The v3 and v4 workers keep **independent block cursors**, so their windows are
  adjacent rather than identical.
- Swap counts are per-**pool**, not per-token: a token trading on two fee tiers
  occupies two rows. `mcap-select` guarantees both rows land on the same board.
