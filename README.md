# angelfish

**PancakeSwap v3 + Infinity** on **BNB Chain**, in two independent processes that
share nothing but a `.env` and a logger:

| | What it does | Run it |
|---|---|---|
| **the indexer** | reads the chain — sweeps Swap logs, ranks tokens onto a Top Movers board and a Danger Zone board, posts to Telegram | `npm start` |
| **the LP bot** | writes to the chain — a DM-only Telegram bot that opens and closes PancakeSwap v3 positions, signing through KeeperHub | `npm run start:lp` |

The indexer never signs anything and the bot never indexes. They point at different
protocols on purpose: the boards index **both** v3 and Infinity, the bot LPs into
**v3** ([why](#pancakeswap-v3-not-infinity--deliberately)).

The indexer sweeps Swap logs in a rolling block window, works out which pools are
anchored in BNB or a USD stable, aggregates per-token trading activity, prices each
token on-chain, and ranks the result into a Top Movers board plus a Danger Zone board
for anything below the market-cap gate. Boards print to stdout and post to Telegram.

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

Both workers run the same seven steps. Only steps 1–3 differ between v3 and Infinity.

| # | Step | PancakeSwap v3 | PancakeSwap Infinity (CL) |
|---|------|----|----|
| 1 | **Find the swaps** | `eth_getLogs` on the v3 Swap `topic0`, **no address filter** — the pool set is discovered from the logs, so a brand-new pool is visible on its first trade | `eth_getLogs` filtered to the **CLPoolManager singleton** + CL Swap `topic0`; every Infinity CL pool trades through that one contract |
| 2 | **Identify the pool** | `token0()` / `token1()` / `fee()` on the pool address, then a **factory check** | Infinity pools aren't contracts — a `bytes32` PoolId is `keccak256(PoolKey)`, one-way — so the key is read back from `CLPoolManager.poolIdToPoolKey(bytes32)` |
| 3 | **Keep the anchored pairs** | exactly one side must be an anchor: WBNB, USDT, USDC or USD1 | same, plus native BNB (`address(0)`) |
| 4 | **Aggregate the window** | Σ\|anchor-leg amount\| as volume, unique swappers as traders, fee = tier × input side | same, except the fee **charged on each swap arrives in the event**, so hook-managed pools value correctly with no extra call |
| 5 | **Record a candle** | last `sqrtPriceX96` of the window → a 5-minute (667-block) bucket, forward-filled across tradeless buckets, feeding RSI-14 | same |
| 6 | **Price the token** | FDV = `totalSupply × price-in-pool × anchor/USD`, where a stable anchor is $1 and BNB comes from the WBNB/USDT `slot0` | same |
| 7 | **Rank and split** | ranked by **volume spike** against each pool's own baseline; established tokens dropped; then ≥ `$300k` FDV → main board, below or unknown → **Danger Zone** | same |

Two properties are what make the boards trustworthy rather than merely populated:

- **Fee valuation and market cap are computed from the pool the token actually
  trades in**, never from an external price API. Most rows need no price feed at
  all — a BSC stablecoin is 18 decimals, so a stable-quoted pool's price *is* a USD
  price.
- **Every "unknown" fails safe.** An unreadable market cap is not evidence of a
  qualifying one, so the row lands in Danger Zone. A transient RPC failure is never
  cached as a negative verdict — only a *confirmed* one is.

### Caching

Nothing is looked up twice if it can be helped, and each cache expires on the
timescale of the thing it holds:

| Cache | Keyed by | Expiry | Why |
|-------|----------|--------|-----|
| v3 pool meta | pool address | permanent | `token0/token1/fee` are immutable |
| Infinity pool key | PoolId | permanent when found, 24h when not | a `PoolKey` is immutable; an unresolved id might just not have been seen yet |
| pool volume history | pool / PoolId | rolling 24 buckets (~2h) | the spike baseline; older activity should stop counting |
| token supply + decimals | token | 1 hour | `totalSupply()` is **not** immutable — a mint should move the cap |
| verification + audit | token | permanent when verified, 6h when not | source can't be un-verified, but an unverified token gets verified later |
| symbol | token | permanent | — |

State persists to `tmp/movers-v3.json` and `tmp/movers-infinity.json`, so a restart
resumes the block cursor rather than replaying.

## Design notes

The non-obvious decisions, each also commented at the code site.

### Two RPC endpoints, because the v3 sweep is topic-only (`bsc/rpc.ts`)

The v3 sweep has **no address filter** by design — that is what makes a new pool
self-discovering on its first trade. Almost every free BSC endpoint refuses such a
query. Measured across nine on 2026-08-15:

| Endpoint | Topic-only `eth_getLogs` |
|---|---|
| `bsc.blockrazor.xyz` | ✅ 25-block cap — the sweep default |
| `1rpc.io/bnb` | ✅ 50-block cap |
| `bsc-rpc.publicnode.com` | ❌ `-32701 "Please specify an address in your request"` |
| `bsc-dataseed.bnbchain.org` | ❌ `-32005 limit exceeded` |
| `bsc-mainnet.public.blastapi.io` | ❌ rate-limited |
| `bsc.meowrpc.com` | ❌ `eth_getLogs is not supported` |
| `bsc.drpc.org`, `rpc.ankr.com/bsc` | ❌ public rate limit / API key required |

So the config splits in two. `BSC_LOG_RPC_URL` serves **only** the v3 sweep; its rate
limit is far too tight for what follows. Everything else — every `eth_call`, plus the
Infinity sweep, which names an address and so is unrestricted — goes to `BSC_RPC_URL`.

Ranges are chunked to `BSC_MAX_LOG_RANGE` *before* the request rather than bisected
after rejection; bisecting spends a rejected round-trip at every level of the
recursion. A reactive split is kept as a backstop for providers that cap on **result
count** instead, which chunking can't predict.

### `eth_call` is batched, and on BSC that is not an optimisation (`bsc/rpc.ts`)

A 300-block window on Ethereum surfaces ~40 pools. The same window here surfaces
**200–280**, and BSC's long tail means most are new each cycle rather than cache hits.
At a measured 192ms per sequential call, resolving one window's pools cost **191s
against a 120s poll interval** — the indexer could not keep pace with the chain at
all.

Pool resolution is therefore phased and batched: one JSON-RPC batch for every
`token0`/`token1` pair, a second for `fee()` on the survivors, a third for the factory
check on those. That alone took a cold cycle from **270s to 43s** (audit disabled).

The market-cap walk got the same treatment for a different reason. It is capped at
`MOVERS_MCAP_MAX_LOOKUPS` and is deliberately **sequential across tokens** — its
laziness is what lets it stop the moment both boards are full — so its cost is
round-trips, and each lookup was spending two of them on `totalSupply()` and
`decimals()`. Batching that pair leaves the ordering and early exit untouched and
halved the stage: **38s → 13s** on the v3 board, **16s → 9s** on Infinity.

A per-item error in a batch yields `null` for that item rather than throwing, so one
bad address can't discard a batch of good answers — and `null` (transient, never
cached) stays distinguishable from `0x` (a definitive "not a pool", always cached).

### v3 forks emit the identical Swap event — ask the factory (`bsc/v3/metadata.ts`)

BSC has a long tail of byte-identical PancakeSwap v3 forks emitting the **same**
`topic0` with the **same** ABI. The unfiltered sweep picks them up and nothing
downstream can tell them apart from the real thing.

So each new pool is checked against the canonical factory:
`getPool(token0, token1, fee) == pool`. One extra `eth_call`, once, batched alongside
reads already being made. A *failed* verification call is deliberately **not** cached
— a timeout must not blacklist a genuine pool for the life of the process.

### The anchor is a set, not a currency (`bsc/anchors.ts`)

This is the one part of the port that is not a rename. On Ethereum the anchor is WETH,
full stop, so a pool's volume is unambiguously an amount of wei. BSC has no
equivalent — WBNB is not the centre of gravity here, USD stables are, and neither
alone is enough. Measured over a 300-block window:

| anchor set | PancakeSwap v3 pools | tokens | Infinity CL pools | CL swaps |
|---|---|---|---|---|
| BNB only | 82/264 | 76 | 18/100 | 1,502/4,232 |
| USDT only | 139/264 | 122 | 72/100 | 2,512/4,232 |
| **BNB + WBNB + USDT/USDC/USD1** | **225/264** | **185** | **84/100** | **3,729 (88%)** |

A straight WBNB-for-WETH substitution would have quietly indexed about 40% of the
chain and produced a board that looked fine.

Two consequences:

- **Selection is an XOR, not "either side is an anchor."** A pool with anchors on
  *both* sides is a stable/stable or BNB/stable pair with no subject token. On BSC
  that is not an edge case — the WBNB/USDT pools are among the busiest on the chain —
  and admitting them would rank USDT on a movers board for trading against BNB.
- **Volume is denominated in USD**, because a figure quoted in one row's anchor is not
  comparable to the next row's. Aggregates stay in raw anchor units and convert once,
  at render time. Every BSC anchor is 18 decimals, so a stable amount *is* a USD
  amount and no float touches it.

The volume **history** deliberately stays in anchor units. A pool always uses the same
anchor, so its own baseline is self-consistent — and a failed BNB/USD read then cannot
corrupt it. Converting first would skip the BNB-quoted pools for that cycle, and
skipped buckets are zero-filled, so a transient price failure would understate those
pools' baselines and inflate their next spike.

### Infinity pool metadata: one mapping, no fallback (`bsc/infinity/metadata.ts`)

A PoolId is `keccak256(abi.encode(PoolKey))` — one-way, so the key cannot be recovered
by arithmetic. It is read back from `CLPoolManager.poolIdToPoolKey(bytes32)`.

**This is materially better than the Uniswap v4 equivalent, and it removes a whole
subsystem.** On Ethereum the key lives on the *PositionManager*, keyed by a truncated
`bytes25`, and only covers pools initialized *through* the PositionManager — measured
at 50 of 52, so that build carries an `Initialize`-log indexer as a second source for
the stragglers. Infinity stores the key on the PoolManager itself, against the full
`bytes32`, written on every initialize regardless of route: **107 of 107** live
PoolIds resolved when measured. There is no second source here because there would be
nothing for it to catch.

Two traps this path has to avoid, both covered by tests:

- The returned tuple is **six words** — `currency0, currency1, hooks, poolManager,
  fee, parameters` — against Uniswap v4's five, and `hooks` moves from last to third.
  Decoding one with the other's offsets reads `hooks` as a fee.
- An empty key can't be detected by a zero `currency0`, because **`address(0)` is
  legitimate** — it's how Infinity represents native BNB. Emptiness is judged on
  `parameters`, which encodes tick spacing and hook flags and is non-zero for every
  real pool.

### The Swap events are *not* Uniswap's, but the decoders are (`bsc/decode.ts`)

Both PancakeSwap events add trailing fields, so both `topic0` hashes differ from their
Uniswap counterparts:

| | signature | vs. Uniswap |
|---|---|---|
| PancakeSwap v3 | `Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)` | +2 trailing `protocolFees` |
| Infinity CL | `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24,uint16)` | +1 trailing `protocolFee` |

Because the extra fields are **appended** rather than inserted, every word the
decoders read keeps its index, and both decode functions are unchanged from the
Ethereum build. Only the constants move.

One guard did have to tighten. Infinity's per-swap fee is set by a hook, and a live
sample contained swaps reporting **980,310 pips — 98%**. That is under the `1e6`
ceiling the Ethereum build used, so its guard would have admitted it and one such swap
would dominate a board's fee column. The ceiling is now a plausible maximum
(`MOVERS_MAX_FEE_PIPS`, default 10%); volume is unaffected either way.

### Boards rank on a volume spike, not absolute volume (`bsc/volume-history.ts`)

Absolute volume is a near-constant property of a pool. The busiest pool is the busiest
pool on almost every window — which is exactly what makes it uninteresting on a
*movers* board. What changes when something happens is a pool's volume **relative to
its own recent baseline**, so that ratio is what the boards rank on and what each row
leads with (`22×`).

**The comparison is per-block rate, not raw totals.** Windows are not a fixed size, so
comparing totals would largely measure how many blocks each side happened to cover;
both sides are divided by their block count first.

Three details the score depends on:

- **Quiet buckets are zero-filled**, the opposite of the candles' forward-fill. A pool
  that did not trade for an hour genuinely had no volume then. Dropping those buckets
  would compute the baseline only over buckets where it happened to trade, overstating
  exactly the quiet pools whose sudden activity is worth surfacing.
- **A volume floor** (`SPIKE_MIN_VOLUME_USD`, default $50) gates eligibility. Without
  it a pool that normally trades dust tops the board on a 400× multiple of nothing —
  the arithmetic is right and the row is worthless. The floor is in **USD** even
  though the baseline is in anchor units: a floor has to mean the same thing to every
  pool to be a floor at all, and "0.05 of the anchor" is $45 for a BNB pool and five
  cents for a USDT one.
- **Warm-up is explicit.** A pool needs `SPIKE_MIN_BUCKETS` (default 3, ≈15 min) of
  history before its baseline means anything. Until then it has no score and is ranked
  by USD volume *behind* every scored pool, and renders `⏳` rather than `1.0×` — the
  two are different claims, and showing `1.0×` would assert a pool is flat when the
  truth is that nothing is known about it yet.

A restart with a volume attached keeps the history, so warm-up is paid once.

### Established tokens are filtered by address, never by symbol (`bsc/denylist.ts`)

Kept as a second line of defence rather than the primary one. The spike ranking already
demotes blue chips on its own; the list makes them absent instead of merely low, and
covers the warm-up window before any baseline exists. `MOVERS_DENYLIST_ENABLED=0`
turns it off and leaves the ranking to do the work.

Stablecoins, bridged majors (BTCB, peg-ETH), and the BNB-chain DeFi set including CAKE
are excluded. Without it the boards are the same dozen names every cycle, which buries
the movement the boards exist to surface.

The stablecoins are both anchors *and* denylisted, deliberately: a USDT/USDC pool is
dropped upstream as anchor-on-both-sides, but USDT paired against a non-anchor stable
reaches the board as the tracked side.

**The match is on address, and that is a correctness requirement rather than a style
choice.** A symbol is not unique and not authenticated: any contract can name itself
`USDT`. Matching the string would hide every impostor that picks a blue-chip ticker —
and a fake `USDT` trading against WBNB is precisely what the Danger Zone board is for.
Symbol matching would turn the filter into a cloaking device for the scams it should
be surfacing. So an impostor stays on the boards and lands in Danger Zone on its
market cap like anything else.

The filter runs **before** the market-cap walk, so an excluded token doesn't also
spend one of the cycle's 25 lookups.

`MOVERS_DENYLIST` adds more, `MOVERS_ALLOWLIST` forces one back on, and
`MOVERS_DENYLIST_ENABLED=0` turns the whole thing off.

### The USD anchor is a pool, not an API

BNB/USD comes from the **PancakeSwap v3 WBNB/USDT 0.01% pool**
(`0x172f…f849`, confirmed via `factory.getPool(WBNB, USDT, 100)` — the 0.01% tier is
the active one, at 840 swaps in a 400-block sample against 14 for the 0.05% pool). Its
`token0` ordering is read from the pool rather than hardcoded, so repointing
`BSC_WBNB_USDT_POOL` can't silently invert the rate.

It matters less here than ETH/USD did on Ethereum, and deliberately so: only the
BNB-anchored rows need it. A failure costs part of a board rather than all of it.

### Contract verification: Sourcify first, Etherscan second (`bsc/audit.ts`)

**There is no Blockscout instance for BNB Chain** — `bsc.blockscout.com`,
`bscscan.blockscout.com`, `binance.blockscout.com` and `bnb.blockscout.com` all 404 —
and BscScan's own V1 API is retired, answering every request with *"You are using a
deprecated V1 endpoint."* So this is a different provider with a different response
shape, not a changed base URL.

Two sources are tried in order:

| | key needed | coverage | shape |
|---|---|---|---|
| **Sourcify** | no | **48/60** real board tokens (80%) | flat `{file: {content}}`, clean 404 when absent |
| **Etherscan V2** (`chainid=56`) | yes, free | covers what Sourcify lacks | `SourceCode` blob, 200 + empty field when absent |

**Sourcify leads because it needs no key**, which is what keeps the badges working
out of the box. Etherscan is optional and simply skipped when unconfigured. Other
keyless options were checked and rejected: Routescan answers `"chain not supported"`
for BSC, and `anyabi.xyz` returns only an ABI, which a *source* scan cannot use.

Two rules govern the chain, and both exist because a mistake here is invisible on the
board but persistent in state:

- **A negative is cached only when *every* source says not-found.** Sourcify holds
  only contracts someone submitted, so its 404 means "not here", not "not verified
  anywhere" — stopping there would badge the ~20% it lacks as unverified.
- **A transient failure abandons the lookup rather than falling through.** Otherwise a
  Sourcify outage would silently demote every token to whatever the next source said,
  and an outage of both would cache "unverified" across the whole board for the TTL.

Etherscan packs a multi-file verification into one `SourceCode` string holding a JSON
document wrapped in an **extra pair of braces**; Sourcify's is already a flat map.
Both are flattened before scanning, because a mint or blacklist usually lives in an
inherited base and scanning only the entry file would quietly stop catching the
common case.

### Cadence follows ~0.45s blocks

BSC blocks are roughly 27× faster than Ethereum's, so the block-count knobs are not
transferable. `BLOCKS_PER_CANDLE=667` keeps a candle at ~5 min — the same duration as
the Ethereum build's 25 blocks, which is what matters, since RSI-14 is then 14
five-minute candles either way. `MOVERS_POLL_SECONDS=120` is ~267 blocks, so a
300-block window gives continuous coverage with a small overlap rather than a gap.

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

### Two services, one image

The project runs **two** Railway services from this same repo:

| Service | Start command | What it does |
|---|---|---|
| `angelfish` | Dockerfile `CMD` (`node dist/index.js`) | the indexer — sweeps and posts boards |
| `angelfish-lp` | `node dist/lp/bot.js` (override) | the LP bot — DM-gated, signs via KeeperHub |

The start-command override on `angelfish-lp` is **load-bearing**. Without it the second
service would inherit the Dockerfile's `CMD` and run a *second indexer*, double-posting
every board and racing on the state files. Set it before the first deploy, not after.

The bot runs `node dist/lp/bot.js` rather than `npm run lp-bot` because the image runs
`npm prune --omit=dev` and `tsx` is a dev dependency — the `lp-bot` script works locally
and would fail in the container. `start:lp` is the deployed entrypoint.

Only the indexer needs the volume; the bot holds no state worth keeping — pending
plans are deliberately in-memory (see above).

**Do not run the bot locally while the deployed one is up.** Two processes polling
`getUpdates` on the same token conflict, and Telegram will 409 one of them.

**Attach a volume** if you want the block cursor and caches to survive a redeploy —
mount it at `/app/tmp` (or point `STATE_DIR` elsewhere). Without one the state files
are lost on each deploy and the next cycle starts from a fresh
`MAX_LOOKBACK_BLOCKS` window, which costs a cold cache but is otherwise harmless.

Run **one instance**. Two would double-post every board and race on the same state
files.

## Reading a row

```
🥇 ROBO 54× ✅🟢 (0.0099%) · RSI — · MC $3.6M
    $288.6K vol · 314 swaps · 35 traders · $28.58 fees
    ↳ 0x475c…f6e2
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
> blue-chips it fires on things that are normal for them: USDT and USDC come
> back `✅🔴` because they genuinely are upgradeable proxies with a `mint` function.
> The verdict is *correct* per the rules; the rules are calibrated for a different
> population. Treat 🔴 on an established token as "read the flags", not "rug".

Volume and fees are in **USD**, not in an amount of the anchor: rows on one board can
be quoted in BNB, USDT, USDC or USD1, so an anchor-denominated figure would not be
comparable between two rows. A `—` there means the value could not be converted — a
BNB-quoted pool during a failed BNB/USD read — and is deliberately not rendered as $0.

`MC` is fully-diluted (total supply × price), not circulating.

## Layout

```
src/
  index.ts                  cycle loop; renders to stdout and posts to Telegram
  env.ts                    zero-dependency .env loader (must be imported first)
  engine/rsi.ts             Wilder's RSI
  types.ts                  MoversRow / MoversBoard, shared by both workers
  bsc/
    config.ts               every BNB Chain constant, each verified live
    anchors.ts              the anchor set, its kinds, and anchor→USD conversion
    rpc.ts                  JSON-RPC: timeout, retry, range chunking, call batching
    decode.ts               ABI word/address helpers + v3 Swap decoder
    price.ts  candles.ts  rsi-tag.ts     price series → 5-min candles → RSI
    onchain-mcap.ts         supply/decimals reads + the FDV formula
    bnb-price.ts            BNB/USD from the WBNB/USDT pool
    volume-history.ts       bucketed volume + the spike score boards rank on
    denylist.ts             established-token exclusion, by address
    mcap-select.ts          lazy market-cap walk → main / danger split
    audit.ts                Etherscan V2 verification + heuristic source scan
    format.ts               stdout board rendering
    v3/        swaps · metadata · state · worker   (PancakeSwap v3)
    infinity/  decode · swaps · metadata · state · worker   (PancakeSwap Infinity CL)
  telegram/
    format.ts               HTML boards with clickable explorer links
    sender.ts               Bot API sendMessage over fetch, no dependency
    chat-id.ts              `npm run chat-id`
    test-post.ts            `npm run test-post`
  lp/                       the LP bot — a separate process, signs via KeeperHub
    bot.ts                  long-poll loop; `npm run start:lp`
    auth.ts                 the whole authorisation surface, one pure function
    commands.ts             command routing and replies
    config.ts               BNB Chain addresses, tick spacings, owner id
    keeperhub.ts            MCP JSON-RPC client: reads, writes, execution history
    pancake.ts              tick maths, amounts, ABIs, unit conversion
    plan.ts                 quote → simulate → execute, for both entry and exit
    pending.ts              single-use confirm codes, in memory on purpose
    audit.ts                token verification + source scan before you fund it
    trail.ts                `/history` — the audit trail, read from KeeperHub
```

## LP bot (`npm run lp-bot`)

A second, independent process: a Telegram DM bot that opens **PancakeSwap v3 positions
on BNB Chain**, signing through KeeperHub. It shares nothing with the indexer but
the `.env` and the logger — the indexer never writes, and the bot never indexes.

```bash
npm run lp-bot
```

```
/pool  USDC WETH 500                     pool price and tick
/lp    USDC WETH 500 100 0.03 10         quote a ±10% position
/lp    USDC WETH 500 0 0.00035           single-sided WETH (see below)
/wrap  0.00035                           ETH -> WETH
/exit                                    list positions, pick one to close
/exit  1                                 close the first one entirely
/exit  1 50                              take out half of it
/audit 0x4691…5d4b                       verification + source scan
/history                                 what this wallet has signed
/confirm 7KQ4MX                          execute it
/positions /wallet /status /cancel /help
```

### What we use KeeperHub for

KeeperHub holds the key and signs, so **this project never touches a private
key** — there is no mnemonic, no keystore and no signing library anywhere in it.
Everything the bot does on-chain is one of these calls:

| KeeperHub tool | What we use it for | Where |
|---|---|---|
| `execute_contract_call` — read | pool price and tick, token decimals/symbol, balances, allowances, position state | `keeperhub.ts` `read` / `readFields` / `readScalar` |
| `execute_contract_call` — `simulate: true` | every step of a plan, before anything is signed | `plan.ts` `simulate()` |
| `execute_contract_call` — write | `approve`, `mint`, `decreaseLiquidity`, `collect`, `burn`, WETH `deposit` | `plan.ts` `execute()` |
| `idempotency_key` | stops a retry after a timeout broadcasting the same mint twice — keyed `lp-<code>-<index>` | `keeperhub.ts` `write()` |
| sponsored gas | executions route through a relayer, so the wallet needs the assets it deposits but **no gas float** | — |
| `list_executions` | the `/history` audit trail | `trail.ts` |
| `get_direct_execution_status` | each trail row's function name, block and receipt | `trail.ts` |

Three quirks worth knowing, each commented at its call site:

- **A tuple argument must be an object.** `mint`, `decreaseLiquidity` and
  `collect` all take structs; sending one as a nested array double-nests and
  fails with `invalid address (argument="token0")`.
- **`simulate` must be a JSON boolean.** The string `"true"` is rejected.
- **A read returns a named object when the ABI outputs are named** (`slot0` →
  `{ sqrtPriceX96, tick, … }`) **and a bare scalar when they are not**
  (`totalSupply` → `"9184992…"`). `readFields` and `readScalar` each assert the
  shape they expect rather than guessing.

Worked end to end against a real position — [the transactions](#proven-live--on-ethereum-before-the-bnb-chain-port).

### The audit trail comes from KeeperHub, not from memory

`/history` reads the execution record back from KeeperHub rather than from
anything this process kept:

```
🧾 audit trail — last 6, newest first
✅ burn · position manager · 2026-08-13 09:15Z
     0x80a7d0cf… · block 25,745,135 · 100,065 gas · sponsored
✅ collect · position manager · 2026-08-13 09:14Z
     0xc64ede69… · block 25,745,134 · 90,117 gas · sponsored
…
```

The bot holds no durable state by design, so a locally accumulated trail would
reset on every redeploy — and a trail with silent gaps is worse than none,
because it reads as complete. KeeperHub's record is server-side, survives
redeploys, and is the same record that settled whether each transaction landed.

Two things the endpoint requires care with, both commented at the call site:

- **The `source` filter does not work.** Asking for `source: 'direct'` answers
  `{ runs: [], total: 6 }` — right count, empty page — while the unfiltered
  request returns all six, every one already carrying `source: 'direct'`. So the
  filtering is done client-side.
- **The list says a call happened, not what was called.** `burn` versus `mint`
  is the entire value of a trail, so each row costs one extra
  `get_direct_execution_status` to resolve its function name. A detail lookup
  that fails degrades to a row that still testifies the execution happened.

### Tokens are audited against their verified source before you fund them

`/lp` accepts a raw address anywhere a symbol goes, which means it will happily
quote a position in a contract nobody has ever read. So the same explorer
verification and heuristic source scan the boards use (`bsc/audit.ts`) runs
on the pair first, and the verdict prints **above** the plan — in front of the
decision rather than as a footnote to it:

```
token audit
⚠️⬜ FOO 0x1234…5678
⚠️ FOO has no published source — nobody can read what it does.
```

It informs, it does not block: `/confirm` is already the gate between a quote
and a signature, and the boards' stance throughout is to surface a verdict
rather than hide the token.

**Only tokens outside the curated alias table are audited automatically**, and
that is calibration rather than laziness. The scan was tuned against memecoin
launches; on blue chips it fires on things that are normal for them. Checked
live, USDT returns `✅🔴 upgradeable` — correct per the rules, and useless above
every routine USDT/WBNB quote, where it would train the reader to ignore the one
badge that matters. `/audit <token>` runs it on anything explicitly, majors
included, and carries the caveat with it.

Unlike the boards, which have room for one glyph per row, `/audit` reports the
**flags** that fired (`has-mint`, `upgradeable`, `owner-privileged`) — a caller
about to commit funds wants to know *why* it is red. `AuditResult.flags` is
optional, so results cached by an earlier build stay readable.

### Exiting is by slot number, not token id

`/exit` with no arguments lists the open positions and numbers them; `/exit 1`
closes the first. Nobody should have to read a seven-digit tokenId off a phone
screen and type it back, which is the only thing the position manager itself
understands.

So a small number is always a **position slot**, never a token id. A number
larger than the list is refused rather than reinterpreted — guessing would
target an unrelated position — and the reply spells out the explicit form,
`/exit #1349240`, for the case where a raw id really is what was meant. The
plan then shows which position it resolved to before `/confirm` signs anything.

A withdrawal is three steps in a fixed order, because `burn` reverts unless both
the liquidity and both owed balances are already zero:

```
decreaseLiquidity  ->  collect  ->  burn   (burn only on a full exit)
```

`collect` passes `uint128` maxima to sweep the principal *and* every fee accrued
since the position was opened. A partial exit stops after the collect and leaves
the NFT alive.

**`amountMin` is derived, not left at zero.** `positionAmounts` values the
liquidity at the pool's current price and the configured slippage comes off
that. A zero floor would let the price be pushed before inclusion so the exit
settles into whichever side an attacker prefers — the mirror image of the guard
the mint path already carries. The tick→price conversion there is floating
point rather than a port of Uniswap's `TickMath`: its output feeds a bound that
then has a whole percent subtracted from it, so a ~1e-15 relative error cannot
move the result. It carries a regression test against the real position this
repo opened — 646,075,971,053 liquidity over ticks 200260–200740 values back out
at the 0.00035 WETH that went in.

Each step simulates against the position as it stands, so `collect` and `burn`
report a revert while the withdraw ahead of them is still pending. That is an
artefact of independent simulation, not a failure, and the reply says so rather
than leaving it to be guessed at.

### Single-sided positions

A wallet holding only one of the two tokens can still LP: pass `0` for the other
amount and the range is placed entirely on one side of the price, so only the token
you hold is required.

Direction is the whole correctness question, and v3 fixes it:

```
currentTick <  tickLower  -> position is 100% token0
currentTick >= tickUpper  -> position is 100% token1
```

So a **token1-only** position needs the range **below** the current tick, and
token0-only needs it **above**. Reversing this asks for the token the wallet does not
hold and reverts with `STF`. `plan.ts` infers the side from whichever amount is zero
rather than making you say it.

The gap between the current price and the near edge (`offsetPct`, default 1%) is not
cosmetic. With no gap, any price drift between quote and inclusion pulls the current
tick inside the range, which makes the mint demand *both* tokens and revert.

Economically a single-sided position is a **limit order**: WBNB placed below the price
in a USDT/WBNB pool sells into USDT as BNB rises through the band.

Wrapping is a separate step because raw BNB is not an ERC20 and cannot be deposited
into a pool — `/wrap` calls WBNB's payable `deposit()`.

### Authorisation is by numeric id, never by username

Exactly one account can command the bot — the numeric Telegram id in
`LP_OWNER_TELEGRAM_ID` — and only in a **private chat**. Both gates are enforced in
`lp/auth.ts` and covered by tests.

Matching on `from.username` would be a real vulnerability rather than a style choice.
Telegram usernames are mutable and can be released and re-registered by anyone; a bot
that signs transactions must not treat one as a credential, or changing the username
would hand the wallet to whoever claims it next. `LP_OWNER_USERNAME` is optional and
is compared only to raise a log warning when it stops matching the id. The DM
requirement is the second gate: a group message's apparent sender can be impersonated
by display name.

The owner id has **no default**, so an unconfigured deployment refuses every message
rather than falling open. It is also deliberately absent from this repository: the
owner's identity is a secret of the deployment, so it lives only in the gitignored
`.env`, and no tracked file — including the tests — names the account.

Both rejections return identical text, so replies can't be used to probe who the owner is.

### Nothing broadcasts without a confirm

`/lp` and `/exit` only ever **simulate**. They read the pool, build the tick range or
value the liquidity, check existing allowances, simulate each step, and store the plan
behind a six-character code. `/confirm <code>` is what signs.

Confirm codes are **single-use and expire in five minutes**, held in memory so they do
not survive a restart. Single-use is the property that matters: a replayed confirm
would mint a second position just as successfully as the first. The TTL exists because
a quote pins a tick range derived from a price that moves. Each step also carries an
idempotency key (`lp-<code>-<index>`), so a retry after a timeout cannot double-broadcast.

### The two traps this path has to avoid

- **A tuple argument must be passed to KeeperHub as an object.** `mint` takes a
  `MintParams` struct; sending it as a nested array double-nests and fails with
  `invalid address (argument="token0")`. `buildMintParams` returns an object for
  exactly this reason.
- **Ticks are logarithmic.** A ±10% band is `ln(1.10)/ln(1.0001)` ≈ 953 ticks wide
  *wherever the pool currently sits*. Treating the percentage as linear in tick space
  would be wildly wrong on a pool far from tick 0 — a USDT/WBNB pool sits near tick
  -66,000, and an 18-vs-6-decimal pair on another chain sits near +200,000. Both
  bounds are then aligned to the tier's `tickSpacing` — lower down, upper up — because
  an unaligned range reverts.

### Why it talks MCP rather than REST

KeeperHub exposes direct execution **only** over its MCP endpoint. The public
`/openapi.json` documents just listed marketplace workflows
(`/api/mcp/workflows/<slug>/call`) — there is no REST route for `execute_contract_call` —
so `lp/keeperhub.ts` speaks MCP JSON-RPC over HTTP, handshake included, and handles
both the JSON and SSE response shapes.

It also normalises a KeeperHub quirk worth knowing: a read returns a **named object**
when the ABI outputs are named (`slot0` → `{ sqrtPriceX96, tick, … }`) but a bare
scalar when they are not (`totalSupply` → `"9184992…"`). `readFields` and `readScalar`
each assert the shape they expect rather than guessing.

### PancakeSwap v3, not Infinity — deliberately

v3's `mint` is a flat tuple on a well-known `NonfungiblePositionManager`
(`0x46A15B0b…4364`, confirmed by its `symbol()` answering `PCS-V3-POS`). Infinity LP
goes through `CLPositionManager.modifyLiquidities`, which takes encoded action
sequences plus Permit2 approvals — far harder to drive through a generic contract-call
tool. So the boards index both protocols while the bot LPs into v3 only.

**PancakeSwap's fee ladder is not Uniswap's**, and the table is load-bearing rather
than informational — a tick range must be a multiple of its pool's spacing or `mint`
reverts. The 0.3%/60 tier does not exist here:

| fee | 100 | 500 | **2500** | 10000 |
|---|---|---|---|---|
| tickSpacing | 1 | 10 | **50** | 200 |

Every pair was read back from a live pool's `fee()` and `tickSpacing()`. Carrying
Uniswap's table over would have made `3000` a silently unsupported tier and mis-spaced
any range quoted against it.

### Before it can execute

Three values, all in the gitignored `.env`, and none of them defaulted:

1. `KEEPERHUB_API_KEY` — create a `kh_…` key in the KeeperHub dashboard.
2. `LP_OWNER_TELEGRAM_ID` — without it the bot refuses every message.
3. `LP_WALLET_ADDRESS` — the address behind the KeeperHub wallet integration.

Gas is **sponsored by KeeperHub**: executions route through a relayer, and the wallet's
BNB balance falls only by the value actually sent, not by gas. So the wallet needs the
assets it intends to deposit, but not a gas float.

### Proven live — on Ethereum, before the BNB Chain port

The path is not theoretical: this code opened a live position and later closed it, so
the **round trip** is proven rather than just the entry. Every transaction below was
signed by the bot through KeeperHub, and all six gas sponsored.

**These executions are on Ethereum mainnet against Uniswap v3**, because that is what
the bot targeted when they ran, and they are left here unaltered as the provenance
they are. What they prove carries over unchanged — the KeeperHub tuple encoding, the
`decreaseLiquidity → collect → burn` ordering, the single-sided tick placement, and
the wei-exactness trap below are all protocol mechanics, and PancakeSwap v3 is Uniswap
v3's fee ladder bolted onto the same contracts. What they do **not** prove is the BNB
Chain path end to end; that awaits a funded wallet on BSC.

**Opening the position** — `/wrap 0.00035` then `/lp USDC WETH 500 0 0.00035`:

| Step | Transaction | Block | Gas |
|---|---|---|---|
| WETH `deposit()` — ETH is not an ERC20, so it must be wrapped first | [`0x5f977a54…`](https://etherscan.io/tx/0x5f977a5484efaca4be2487cf40a59fae84aaca629fbe85739787ed05cb489294) | 25,744,442 | 101,165 |
| `approve` WETH → position manager | [`0xdc80f7c4…`](https://etherscan.io/tx/0xdc80f7c455caea5218fc420f227b3e7e2b2cb74b889c618118a7c319452ab5ea) | 25,744,460 | 68,355 |
| `mint` | [`0x1384bd7c…`](https://etherscan.io/tx/0x1384bd7c666281756574351b2ff7fc0fc81c0b77c6a00a0a26b37036dd27d985) | 25,744,465 | 423,240 |

Result: tokenId **1349240**, USDC/WETH 0.05%, ticks **200260–200740**, liquidity
**646,075,971,053** — single-sided WETH, placed below the price, so it needed
only the one token the wallet held.

**Closing it** — `/exit 1`:

| Step | Transaction | Block | Gas |
|---|---|---|---|
| `decreaseLiquidity` | [`0xadb42281…`](https://etherscan.io/tx/0xadb4228146c12011e748fa60da4892e5dafb0bc6087becc568a6c7d37c121062) | 25,745,131 | 167,361 |
| `collect` | [`0xc64ede69…`](https://etherscan.io/tx/0xc64ede695353462485f5fa688a89ead8fb21612af77cdca65717faa59bc1b094) | 25,745,134 | 90,117 |
| `burn` | [`0x80a7d0cf…`](https://etherscan.io/tx/0x80a7d0cf63026141b3463696ac472e213cd93d6d5496bc68a89cb5d41f37b051) | 25,745,135 | 100,065 |

Recovered **0.000349999999999999 WETH** — the deposit back, one wei short from
AMM rounding. That single wei is not a curiosity: `toBaseUnits` is exact, so
re-running `/lp … 0 0.00035` afterwards asks for 350000000000000 wei against a
balance of 349999999999999 and reverts with `STF`.

All six rows above are exactly what `/history` prints, because they come from
the same KeeperHub record.

`singleSidedTicks` carries a regression test pinned to that exact range, and
`positionAmounts` carries one pinned to the same position's value.

Two things the exit confirmed that only a live run could:

- **KeeperHub encodes `DecreaseLiquidityParams` and `CollectParams` from an
  object**, exactly as it does `MintParams`. The receipts show
  `decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))` and
  `collect((uint256,address,uint128,uint128))` resolved correctly.
- **`burn` really does need the position cleared first.** It simulated as
  `Error(Not cleared)` right up until the decrease and collect ahead of it had
  actually executed, which is why the three steps are ordered rather than
  independent — and why the reply explains that revert instead of hiding it.

## Known limits

- **The market-cap lookup ceiling is reached routinely.** A window here holds
  200–280 pools against a default `MOVERS_MCAP_MAX_LOOKUPS=25`, so the walk is
  almost always cut short — which is logged, loudly, and means a board can be
  incomplete. This is a much tighter bind than on Ethereum, where a window held ~30
  pools: the ceiling now stops the walk after roughly the top tenth of the ranking.
  Raising it costs two sequential `eth_call`s per extra lookup, since the walk is
  deliberately lazy and cannot be batched without pricing every token to find out
  which ones mattered.
- **Verification coverage is ~80% without a key.** Sourcify answered for 48 of 60
  sampled board tokens; the rest render `⚠️⬜`. Setting the free
  `BSC_EXPLORER_API_KEY` adds Etherscan V2 as a second source to cover the gap.
- **Cycle time is network-bound and varies a lot.** With the audit enabled a cold
  cycle measured **58–86s** across runs, against `MOVERS_POLL_SECONDS=120` and a
  300-block window spanning ~135s of chain — so there is headroom, but not a wide
  margin. Nearly all the variance is upstream latency in the market-cap and metadata
  stages; the audit is ~13s of it. An overrun is absorbed by the `cycleRunning` guard
  and logged, but it costs a skipped window, so raise `MOVERS_MAX_LOOKBACK_BLOCKS` if
  you see the downtime clamp firing.
- **The LP bot's BNB Chain path has not executed live.** Every address is verified
  on-chain and the fee ladder is corrected, but the round trip in
  [Proven live](#proven-live--on-ethereum-before-the-bnb-chain-port) ran on Ethereum
  against Uniswap v3. The BSC path awaits a funded wallet.
- **The v3 sweep depends on one of two endpoints.** Only `bsc.blockrazor.xyz` and
  `1rpc.io/bnb` answer a topic-only `eth_getLogs` at all. If both are down the v3
  board stops; the Infinity board, which filters on an address, is unaffected.
- **Only Infinity's CL pools are indexed, not Bin.** `BinPoolManager` is deployed and
  functional but returned **one** log in a 300-block sample against CLPoolManager's
  4,341. It also uses a discrete-bin AMM rather than `sqrtPriceX96`, so none of the
  pricing or candle code would apply to it.
- The v3 and Infinity workers keep **independent block cursors**, so their windows
  are adjacent rather than identical.
- Swap counts are per-**pool**, not per-token: a token trading on two fee tiers
  occupies two rows. `mcap-select` guarantees both rows land on the same board.
- **Volume history is capped at 500 pools** (LRU). A window routinely holds more than
  half that, so on a busy chain the least recently active pools lose their baseline
  and fall back to warm-up.
