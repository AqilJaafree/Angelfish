# angelfish

Uniswap **v3 + v4** ETH-pair swap indexer for **Ethereum mainnet**.

It sweeps Swap logs in a rolling block window, works out which pools are ETH-paired,
aggregates per-token trading activity, prices each token on-chain, and ranks the
result into a Top Movers board plus a Danger Zone board for anything below the
market-cap gate. Boards print to stdout and post to Telegram.

## Quick start

```bash
npm install
cp .env.example .env      # RPC defaults work as-is
npm run chat-id           # optional: discover the Telegram chat to post to
npm run once              # one cycle
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
| 7 | **Rank and split** | ranked by **volume spike** against each pool's own baseline; established tokens dropped; then ≥ `$300k` FDV → main board, below or unknown → **Danger Zone** | same |

Two properties are what make the boards trustworthy rather than merely populated:

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
| pool volume history | pool / PoolId | rolling 24 buckets (~2h) | the spike baseline; older activity should stop counting |
| token supply + decimals | token | 1 hour | `totalSupply()` is **not** immutable — a mint should move the cap |
| verification + audit | token | permanent when verified, 6h when not | source can't be un-verified, but an unverified token gets verified later |
| symbol | token | permanent | — |

State persists to `tmp/movers-v3.json` and `tmp/movers-v4.json`, so a restart
resumes the block cursor rather than replaying.

## Design notes

The non-obvious decisions, each also commented at the code site.

### `eth_getLogs` is range-capped — chunk up front (`mainnet/rpc.ts`)

Free mainnet endpoints cap the block span hard. blastapi answers a 1000-block query
with:

```
-32600 "You can make eth_getLogs requests with up to a 10 block range"
```

So the range is chunked to `ETH_MAX_LOG_RANGE` (default 10) *before* the request,
rather than bisected after rejection — bisecting spends a rejected round-trip at
every level of the recursion, ~31 wasted calls to get a 300-block window down to 10.
A reactive split is kept as a backstop, because some providers cap on **result
count** instead, which chunking can't predict.

Raise `ETH_MAX_LOG_RANGE` on a paid endpoint; every increase is one fewer round-trip
per cycle.

### Not every RPC allows the v3 sweep at all

The v3 sweep is topic-only by design (that's what makes new pools self-discovering),
and some endpoints refuse those outright. Measured 2026-08-13:

| Endpoint | Topic-only `eth_getLogs` |
|---|---|
| `eth-mainnet.public.blastapi.io` | ✅ (10-block cap) — the default |
| `eth.drpc.org` | ✅ (10-block cap, needs a browser `User-Agent` or it 403s) |
| `ethereum-rpc.publicnode.com` | ❌ `-32701 "Please specify an address in your request"` |
| `eth.merkle.io` | ❌ method not found |

### v3 forks emit the identical Swap event — ask the factory (`mainnet/v3/metadata.ts`)

Mainnet has a long tail of byte-identical v3 forks (SushiSwap v3 and others) emitting
the **same** `topic0` with the **same** ABI. The unfiltered sweep picks them up and
nothing downstream can tell them apart from the real thing.

So each new pool is checked against the canonical factory:
`getPool(token0, token1, fee) == pool`. One extra `eth_call`, once, cached alongside
reads already being made. A *failed* verification call is deliberately **not** cached
— a timeout must not blacklist a genuine pool for the life of the process.

### v4 pool metadata: `poolKeys`, not an `Initialize` scan (`mainnet/v4/metadata.ts`)

The obvious way to recover a PoolId's currencies is to scan `Initialize` logs
filtered on that id. On mainnet that range is over 4 million blocks (PoolManager
deployed at **21,688,329** — verified by `eth_getCode` being empty at 21,688,328 and
48,020 bytes at 21,688,329), and at a 10-block cap it would cost **~400,000 requests
per unknown pool**.

Instead the PoolKey is read back from `PositionManager.poolKeys(bytes25)`, the mapping
v4 maintains for exactly this purpose. One `eth_call`, no range to negotiate, works
for a pool of any age. Measured on a live 9-block window: **50 of 52** PoolIds
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

### Boards rank on a volume spike, not absolute volume (`mainnet/volume-history.ts`)

Absolute volume is a near-constant property of a pool. USDC/WETH is the most heavily
traded pool on almost every window — which is exactly what makes it uninteresting on
a *movers* board. What changes when something happens is a pool's volume **relative to
its own recent baseline**, so that ratio is what the boards rank on and what each row
leads with (`22×`).

Measured live with the denylist off: USDC scored `1.2×` and `0.2×` and fell to 3rd and
4th, while a pool that had woken up scored `54×` and took the top slot. Blue chips
score ~1× by construction, so they stop needing to be excluded by name.

**The comparison is per-block rate, not raw totals.** Windows are not a fixed size —
steady state sweeps ~10 blocks, a cold start clamps to `MAX_LOOKBACK_BLOCKS` (300),
and a history bucket spans 25. Comparing totals would largely measure how many blocks
each side happened to cover, so both sides are divided by their block count first.

Three details the score depends on:

- **Quiet buckets are zero-filled**, the opposite of the candles' forward-fill. A pool
  that did not trade for an hour genuinely had no volume then. Dropping those buckets
  would compute the baseline only over buckets where it happened to trade, overstating
  exactly the quiet pools whose sudden activity is worth surfacing.
- **A volume floor** (`SPIKE_MIN_VOLUME_WEI`, default 0.05 ETH) gates eligibility.
  Without it a pool that normally trades dust tops the board on a 400× multiple of
  nothing — the arithmetic is right and the row is worthless.
- **Warm-up is explicit.** A pool needs `SPIKE_MIN_BUCKETS` (default 3, ≈15 min) of
  history before its baseline means anything. Until then it has no score and is ranked
  by volume *behind* every scored pool, and renders `⏳` rather than `1.0×` — the two
  are different claims, and showing `1.0×` would assert a pool is flat when the truth
  is that nothing is known about it yet.

A restart with a volume attached keeps the history, so warm-up is paid once.

### Established tokens are filtered by address, never by symbol (`mainnet/denylist.ts`)

Kept as a second line of defence rather than the primary one. The spike ranking already
demotes blue chips on its own; the list makes them absent instead of merely low, and
covers the warm-up window before any baseline exists. `MOVERS_DENYLIST_ENABLED=0`
turns it off and leaves the ranking to do the work.


Stablecoins, wrapped majors, ETH liquid-staking derivatives and DeFi blue chips are
excluded. Without it the boards are the same dozen names every cycle — USDC, USDT and
WBTC alone routinely took three of the five v3 slots — which buries the movement the
boards exist to surface.

**The match is on address, and that is a correctness requirement rather than a style
choice.** A symbol is not unique and not authenticated: any contract can name itself
`USDC`. Matching the string would hide every impostor that picks a blue-chip ticker —
and a fake `USDC` trading against WETH is precisely what the Danger Zone board is for.
Symbol matching would turn the filter into a cloaking device for the scams it should
be surfacing. So an impostor stays on the boards and lands in Danger Zone on its
market cap like anything else.

The filter runs **before** the market-cap walk, so an excluded token doesn't also
spend one of the cycle's 25 lookups establishing a $49B cap nobody needed.

Every listed address was verified against its on-chain `symbol()` before being added.
`MOVERS_DENYLIST` adds more, `MOVERS_ALLOWLIST` forces one back on, and
`MOVERS_DENYLIST_ENABLED=0` turns the whole thing off.

### The USD anchor is a pool, not an API

ETH/USD comes from the **USDC/WETH 0.05% pool** (`0x88e6…5640`, confirmed via
`factory.getPool(USDC, WETH, 500)`). Its `token0` ordering is read from the pool
rather than hardcoded, so repointing `ETH_USDC_WETH_POOL` can't silently invert the
rate.

### Cadence follows ~12s blocks

`BLOCKS_PER_CANDLE=25` ≈ 5 min and `MAX_LOOKBACK_BLOCKS=300` ≈ 1 h of catch-up after
downtime. `MOVERS_POLL_SECONDS=120`, because a measured cycle is ~73s warm on the free
endpoint and a 60s interval would fire mid-cycle every time.

### Transport is dependency-free and dispatched from `index.ts`

Only `sendMessage` is needed — no long-polling, no command handling — so
`telegram/sender.ts` talks to the Bot API over `fetch` with no dependency.

The workers return `{ main, danger }` and know nothing about where the rows go;
`index.ts` renders them to stdout **and** posts them. That keeps the indexing path
transport-agnostic and means a send failure can't reach the code that advances the
block cursor.

## Telegram setup

A bot cannot open a conversation — the chat has to reach it first:

```bash
npm run chat-id      # starts listening
```

then send `/start` to the bot, or add it to a group and post anything there. The
script writes `TELEGRAM_CHAT_ID` into `.env`.

**Forum topics.** Set `V3_MOVERS_TOPIC_ID` and `V4_MOVERS_TOPIC_ID` to route each
version to its own topic; the ids are the trailing number in a topic's `t.me/c/…`
link. A Danger Zone board falls back to its own version's topic, so all of a
version's data stays in one place — set `DANGER_ZONE_TOPIC_ID` to collect both
versions' danger rows in a single separate topic instead.

`TELEGRAM_ENABLED=0` runs the indexer without posting. If the token is present but
the chat id is not, the process logs one warning and keeps printing to stdout.

`npm run test-post` sends a synthetic board covering the cases live windows rarely
produce together — hostile symbol, unknown cap, sub-dollar cap, dynamic fee tier,
both RSI extremes, missing badges.

Two send-path behaviours worth knowing:

- A **429 is retried for exactly as long as Telegram asks** (`parameters.retry_after`).
  Guessing a backoff instead of honouring it is what turns a brief flood-wait into a
  banned token.
- A board that would exceed Telegram's 4096-character limit **drops whole rows** from
  the tail. Cutting the text instead would sever an HTML tag, and Telegram rejects an
  unparseable body outright — costing the entire board rather than its last row.

## Deploying on Railway

The service is a long-running worker with no HTTP port.

```bash
railway init
railway variables --set TELEGRAM_BOT=… --set TELEGRAM_CHAT_ID=…
railway up
```

`Dockerfile` builds and runs `npm start`. Set at minimum `TELEGRAM_BOT` and
`TELEGRAM_CHAT_ID`; everything else has a working default.

**Attach a volume** if you want the block cursor and caches to survive a redeploy —
mount it at `/app/tmp` (or point `STATE_DIR` elsewhere). Without one the state files
are lost on each deploy and the next cycle starts from a fresh
`MAX_LOOKBACK_BLOCKS` window, which costs a cold cache but is otherwise harmless.

Run **one instance**. Two would double-post every board and race on the same state
files.

## Reading a row

```
🥇 WOO 54× ✅🟢 (0.3%) · RSI — · MC $32.0M
    Ξ0.1581 vol · 12 swaps · 8 traders · Ξ0.0006 fees
    ↳ 0x4691…5d4b
```

Line 1 is identity and signals, line 2 is activity in the window, line 3 is the
contract — **the contract address is the source of truth**, a symbol is not unique.

`54×` is the headline: this pool is trading at 54 times its own recent baseline. `⏳`
means the pool has not built a baseline yet, which is not the same as being flat.

The two badges answer two different questions and are kept separate on purpose:
`✅`/`⚠️` is *can we see the source*, and `🟢🟡🔴⬜` is *what does the source do*.
`✅🔴` ("public and dangerous") and `⚠️⬜` ("we can't see it at all") are very
different situations.

> **Calibration note.** The risk heuristic was tuned against memecoin launches. On
> mainnet blue-chips it fires on things that are normal for them: USDC and USDT come
> back `✅🔴` because they genuinely are upgradeable proxies with a `mint` function.
> The verdict is *correct* per the rules; the rules are calibrated for a different
> population. Treat 🔴 on an established token as "read the flags", not "rug".

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
    volume-history.ts       bucketed volume + the spike score boards rank on
    denylist.ts             established-token exclusion, by address
    mcap-select.ts          lazy market-cap walk → main / danger split
    audit.ts                explorer verification + heuristic source scan
    format.ts               stdout board rendering
    v3/  swaps · metadata · state · worker
    v4/  decode · swaps · metadata · state · worker
  telegram/
    format.ts               HTML boards with clickable explorer links
    sender.ts               Bot API sendMessage over fetch, no dependency
    chat-id.ts              `npm run chat-id`
    test-post.ts            `npm run test-post`
```

## Known limits

- **RPC-call-bound.** Almost all cycle time is sequential `eth_call` latency at
  ~330ms each on the free endpoint. JSON-RPC **batching** would collapse each pool's
  `token0`/`token1`/`fee`/`getPool` into a single request and is the highest-value
  optimisation available; it is not implemented here.
- **The first cycle after a cold start is slow — around 6 minutes per version.**
  With no cursor it clamps to the full `MAX_LOOKBACK_BLOCKS` window, which at a
  10-block chunk cap is 30 sequential `eth_getLogs` calls over ~200 distinct pools.
  Steady-state cycles sweep only the ~10 blocks since the last one and take well
  under a minute. Attaching a volume keeps the cursor and caches across deploys, so
  the cold start is paid once rather than on every release.
- **The market-cap lookup ceiling is reached routinely.** A mainnet window holds
  ~30 pools against a default `MOVERS_MCAP_MAX_LOOKUPS=25`, so the walk is often
  cut short — which is logged, loudly, and means the board can be incomplete.
- The v3 and v4 workers keep **independent block cursors**, so their windows are
  adjacent rather than identical.
- Swap counts are per-**pool**, not per-token: a token trading on two fee tiers
  occupies two rows. `mcap-select` guarantees both rows land on the same board.
