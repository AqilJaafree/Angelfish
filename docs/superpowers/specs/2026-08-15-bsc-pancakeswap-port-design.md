# angelfish on BNB Chain — porting off Ethereum/Uniswap

**Date:** 2026-08-15
**Decision:** full replacement. Ethereum and Uniswap are removed, not kept alongside.
**Scope:** PancakeSwap v3 + PancakeSwap Infinity (CL). BinPoolManager is out.

Every address, topic0, and coverage figure below was measured live against BSC on
2026-08-15 (head ≈ 116,033,800), not taken from documentation.

## What carries over unchanged

The two log decoders are drop-in. Both signatures were confirmed by keccak against
observed topic0s:

| | signature | topic0 | vs. Uniswap |
|---|---|---|---|
| PancakeSwap v3 | `Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)` | `0x19b47279…dc83` | words 0–2 identical, +2 trailing `protocolFees` |
| Infinity CL | `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24,uint16)` | `0x04206ad2…d237` | words 0–5 identical, +1 trailing `protocolFee` |

`wordAt` indexes positionally and `hasWords` is a `>=` minimum, so trailing words are
ignored for free. `decodeSwapLog` and `decodeV4SwapLog` need no change; only the
topic0 constants move.

All concentrated-liquidity tick math in `lp/pancake.ts` (`rangeTicks`,
`singleSidedTicks`, `positionAmounts`, `sqrtRatioAtTickX96`) is unchanged — v3 is v3.

## 1. Anchors and denomination

A single WETH-equivalent anchor does not work on BSC. Measured over 300 blocks:

| anchor set | PCS v3 pools | PCS v3 tokens | Infinity CL pools | CL swaps |
|---|---|---|---|---|
| BNB only | 82/264 | 76 | 18/100 | 1,502/4,232 |
| USDT only | 139/264 | 122 | 72/100 | 2,512/4,232 |
| **BNB + WBNB + USDT/USDC/USD1** | **225/264** | **185** | **84/100** | **3,729 (88%)** |

A WBNB-only port drops ~60% of activity. So:

- `src/bsc/anchors.ts` holds the anchor set and each anchor's `kind` (`'usd' | 'bnb'`).
- Pools are filtered by **XOR** on the anchor set — a pool anchored on both sides is a
  stable/stable or BNB/stable pair with no subject token, and must be dropped.
- Pool metadata records **which** anchor the pool used.

Every BSC anchor is 18 decimals (WBNB, USDT, USDC, USD1, BUSD — all verified). So a
stable-anchored raw amount *is* the USD amount in 1e18 fixed point.

**Denomination:** aggregates stay **raw in anchor units** (`volumeAnchor`), exactly as
they are today. Conversion to USD happens once, at row-build time, where the anchor
rate is already resolved. This is deliberate:

- it preserves the existing "aggregate raw, price late" ordering;
- the spike baseline in `volume-history` compares a pool against *itself*, always in
  the same anchor, so it stays valid with no change;
- the 139 USDT-anchored v3 pools need no BNB/USD rate at all.

`MoversRow.volumeWeth`/`feesWeth` become `volumeUsd`/`feesUsd`, bigints in 1e18.

## 2. Infinity metadata is simpler than Uniswap v4's

`CLPoolManager.poolIdToPoolKey(bytes32)` (selector `0x0e2d484a`) resolved **107/107**
live PoolIds — read off the PoolManager itself, keyed by the *full* bytes32.

Deleted as a result: `toBytes25Arg`, `V4_INITIALIZE_TOPIC0`, `decodeV4InitializeLog`,
`indexInitializeLogs`, the deploy-block floor, and the whole Initialize-log fallback.
The fallback exists on mainnet because `poolKeys` only manages 50/52 there; Infinity's
mapping is written by the PoolManager on every initialize, so 100% is structural.

Returned tuple is 6 words — `currency0, currency1, hooks, poolManager, fee, parameters`
— against Uniswap's 5, so word offsets shift. Emptiness is judged on `parameters`
being zero (currency0 == address(0) is legitimately native BNB).

## 3. RPC topology

The v3 sweep is topic-only *by design* — that is what makes a new pool visible on its
first trade. Most BSC endpoints reject it. Of nine tested:

| endpoint | topic-only `eth_getLogs` |
|---|---|
| `bsc-rpc.publicnode.com` | ✗ `-32701 "Please specify an address"` |
| `bsc-dataseed.bnbchain.org` | ✗ `-32005 limit exceeded` |
| `bsc.drpc.org`, `rpc.ankr.com/bsc` | ✗ rate-limited / key required |
| `bsc-mainnet.public.blastapi.io`, `bsc.meowrpc.com` | ✗ |
| `1rpc.io/bnb` | ✓ 50-block cap |
| `bsc.blockrazor.xyz` | ✓ 25-block cap |

So the RPC config splits in two:

- `BSC_RPC_URL` → `bsc-rpc.publicnode.com`. Serves the `eth_call` storm and the
  Infinity worker, which address-filters the CLPoolManager singleton and needs nothing
  special.
- `BSC_LOG_RPC_URL` → `bsc.blockrazor.xyz`, with `BSC_MAX_LOG_RANGE=25`. Used **only**
  by the v3 sweep.

`rpc.ts` gains a `call`/`log` endpoint split and keeps its existing 429 backoff
(blockrazor's limiter was hit during measurement).

### 3b. `eth_call` batching — found during implementation, not in the original design

The first working build was measured at **191s for the v3 metadata stage against a
120s poll**, i.e. the indexer could not keep pace with the chain. The cause is a
difference of scale rather than a defect: a 300-block window on Ethereum surfaces ~40
pools, the same window here surfaces **200–280**, and BSC's long tail means most are
new each cycle rather than cache hits. At a measured 192ms per sequential `eth_call`,
four calls per pool is ~190s.

publicnode serves JSON-RPC batches — 300 calls in 725ms against ~57s sequential — so
pool resolution became phased and batched: one batch for all `token0`/`token1` pairs,
a second for `fee()` on the survivors, a third for the factory check on those.

Measured end to end: **cold cycle 270s → 43s.**

The market-cap walk stays sequential on purpose. Its laziness is what bounds lookups
to 25 per cycle and lets it stop as soon as both groups are full; batching it would
mean pricing every token to discover which ones were needed.

A per-item batch error yields `null` for that item rather than throwing, which keeps
the existing caching rule intact: `null` is transient and never cached, `0x` is a
definitive "not a pool" and always is.

## 4. Cadence

BSC blocks are ~0.45s, not ~12s.

| knob | mainnet | BSC | why |
|---|---|---|---|
| `BLOCKS_PER_CANDLE` | 25 | **667** | keeps a candle at ~5 min |
| `POLL_SECONDS` | 120 | 120 | ≈267 blocks — a 300-block window stays continuous |
| `MAX_LOOKBACK_BLOCKS` | 300 | 300 | ~2.3 min of activity ≈ 3.5k v3 + 4.3k CL swaps |

## 5. Audit loses its explorer

There is no Blockscout for BSC — `bsc.blockscout.com` and three alt hosts all 404, and
BscScan V1 is deprecated in favour of Etherscan V2 (`chainid=56`), which requires a
free API key.

`audit.ts` therefore needs a real adapter, not a URL swap: Etherscan returns
`result[0].SourceCode` (sometimes a JSON blob of several files, brace-wrapped) rather
than Blockscout's `source_code` + `additional_sources`. With no key configured it
degrades to today's `MOVERS_AUDIT_ENABLED=0` behaviour — no badges, no failed calls.

The source-scan heuristic (`scanSource`) is chain-independent and unchanged.

## 6. LP bot

| | Ethereum | BSC |
|---|---|---|
| chain id | 1 | 56 |
| position manager | `0xC36442b4…FE88` | `0x46A15B0b…4364` (`PCS-V3-POS`) |
| factory | `0x1f98431c…f984` | `0x0BFbCF9f…1865` |

Fee tiers verified live on real pools — **`3000→60` is gone, replaced by `2500→50`**:

```
100→1    500→10    2500→50    10000→200
```

This is load-bearing: a plan quoting fee 3000 must be rejected outright rather than
silently mis-spaced. `WETH_DEPOSIT_ABI` becomes WBNB (same `deposit()`/`withdraw()`
interface). The `TOKENS` alias table is retargeted to BSC addresses.

## 7. Fee-word ceiling

The Infinity fee word is per-swap pips and was mostly sane in the sample (99, 999,
5999), but 5 swaps read **980310 pips = 98%**, which today's `fee < 1_000_000n` guard
would admit and print. The ceiling tightens to a plausible maximum so an exotic hook
pool cannot inflate the fee column.

## Layout

```
src/bsc/            (was src/mainnet)
  anchors.ts        NEW — anchor set, kinds, XOR selection
  config.ts         all constants retargeted
  bnb-price.ts      (was eth-price.ts)
  v3/               PancakeSwap v3
  infinity/         (was v4/) PancakeSwap Infinity CL
src/lp/pancake.ts   (was uniswap.ts)
```

`engine/`, `telegram/` (bar its labels and explorer link), `logger`, and `env` are
untouched. `denylist.ts` gets a fresh BSC token list — the mainnet one is entirely
ETH-specific.

## Testing

Existing unit tests port with their modules; the ones asserting mainnet addresses,
`3000→60` spacing, or wei formatting are updated to their BSC equivalents. New tests
cover: anchor XOR selection, `usd`-vs-`bnb` conversion, the 6-word Infinity PoolKey
decode, and the Etherscan source adapter. Verification is `npm test` plus a live
`npm run once` against BSC with Telegram disabled.
