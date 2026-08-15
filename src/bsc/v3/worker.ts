import { logger } from '../../logger';
import * as rpc from '../rpc';
import { addressAt, decodeSwapLog, decodeSymbol, hasWords, wordAt } from '../decode';
import { aggregateSwaps, feesToAnchor, rankTopN, PoolMeta } from './swaps';
import { resolvePoolMetas } from './metadata';
import { loadState, saveState, MoversState } from './state';
import { resolveAudit } from '../audit';
import { formatFeeTier } from '../format';
import { MoversRow } from '../../types';
import {
  V3_SWAP_TOPIC0,
  SEL_SLOT0,
  SEL_SYMBOL,
  SEL_TOKEN0,
  TOP_N,
  MAX_LOOKBACK_BLOCKS,
  BLOCKS_PER_CANDLE,
  RSI_MIN_VOLUME_ANCHOR,
  MIN_MARKET_CAP_USD,
  MCAP_MAX_LOOKUPS,
  ANCHOR_DECIMALS,
  WBNB_USDT_POOL,
  WBNB,
  BSC_LOG_RPC_URL,
  RANK_BY,
} from '../config';
import { BoardKey, BOARDS, boardForAnchor, toUsd } from '../anchors';
import { sqrtPriceToSeriesValue } from '../price';
import { recordSwapPrice } from '../candles';
import { recordVolume, spikeScore, sortBySpike, sortBySwaps } from '../volume-history';
import { rsiForSeries } from '../rsi-tag';
import { resolveTokenMeta, computeFdvUsd } from '../onchain-mcap';
import { resolveBnbUsd } from '../bnb-price';
import { selectByMarketCap } from '../mcap-select';
import { filterDenied } from '../denylist';

let stateFile = '';
let state: MoversState;

export function initMovers(file: string): void {
  stateFile = file;
  state = loadState(file);
}

async function resolveSymbol(token: string): Promise<string> {
  const cached = state.symbols[token];
  if (cached) return cached;
  try {
    const decoded = decodeSymbol(await rpc.call(token, SEL_SYMBOL));
    if (decoded) {
      state.symbols[token] = decoded; // persist successful resolutions
      return decoded;
    }
  } catch (err) {
    logger.warn({ err, token }, 'movers-v3: symbol() failed, using address fallback');
  }
  return token.slice(0, 8); // transient fallback, retried next cycle
}

// Guard against overlapping cycles (the interval fires regardless of whether the
// previous cycle finished; they share module-level `state`).
let cycleRunning = false;

// One published board's worth of rows. A cycle produces one of these per entry in
// BOARDS — WBNB pairs and USDT pairs — from a SINGLE sweep of the window. Running
// two workers instead would double the topic-only getLogs storm (12 chunked
// requests at the 25-block cap) to re-read blocks already in hand, so the sweep,
// the metadata resolution and the candle/volume recording all stay shared and only
// the ranking downstream of them is split.
export interface BoardResult {
  key: BoardKey;
  label: string;
  main: MoversRow[];
  danger: MoversRow[];
}

export interface CycleResult {
  boards: BoardResult[];
  fromBlock: number;
  toBlock: number;
}

export async function moversCycle(): Promise<CycleResult | undefined> {
  if (cycleRunning) {
    logger.warn('movers-v3: previous cycle still running, skipping this tick');
    return undefined;
  }
  cycleRunning = true;
  try {
    const currentBlock = await rpc.blockNumber();

    // Window = blocks since last post (clamped after downtime / first run).
    let fromBlock = state.lastProcessedBlock + 1;
    if (
      state.lastProcessedBlock === 0 ||
      currentBlock - state.lastProcessedBlock > MAX_LOOKBACK_BLOCKS
    ) {
      fromBlock = Math.max(1, currentBlock - MAX_LOOKBACK_BLOCKS + 1);
      if (state.lastProcessedBlock > 0 && fromBlock > state.lastProcessedBlock + 1) {
        logger.warn(
          { skippedFrom: state.lastProcessedBlock + 1, resumedFrom: fromBlock },
          'movers-v3: downtime clamp, skipping blocks'
        );
      }
    }
    if (currentBlock < fromBlock) {
      saveState(stateFile, state);
      return undefined;
    }

    // 1. Sweep ALL PancakeSwap v3 Swap logs in the window. No address filter — the
    //    pool set is discovered from the logs themselves, which is what makes a
    //    newly-created pool visible on its very first trade.
    //
    //    This sweep runs against BSC_LOG_RPC_URL rather than the default endpoint.
    //    A topic-only query is what almost every free BSC endpoint refuses (see
    //    config.ts), so the one provider that answers it serves this call and
    //    nothing else — its rate limit is far too tight for the eth_call storm that
    //    follows, which stays on the general endpoint.
    //
    // Announce the sweep BEFORE it runs: a cold start clamps to
    // MAX_LOOKBACK_BLOCKS, which at a 25-block chunk cap is 12 sequential requests
    // followed by a few hundred pool resolutions — minutes of work. Without this
    // line that whole stretch emits nothing at all, and a slow endpoint is
    // indistinguishable from a hung process for as long as it lasts.
    logger.info(
      { fromBlock, toBlock: currentBlock, blocks: currentBlock - fromBlock + 1 },
      'movers-v3: sweeping window'
    );
    const logs = await rpc.getLogs({
      topics: [V3_SWAP_TOPIC0],
      fromBlock,
      toBlock: currentBlock,
      endpoint: BSC_LOG_RPC_URL,
    });
    // No address filter, so a foreign contract emitting the same Swap topic0 with
    // NON-indexed sender/recipient (topics.length < 3) would make decodeSwapLog
    // throw on topics[1]/[2] and — since this runs before the cursor advances —
    // wedge the cursor on this window forever. Drop such logs defensively.
    const usable = logs.filter((log) => log.topics.length >= 3);
    if (usable.length !== logs.length) {
      logger.warn(
        { dropped: logs.length - usable.length },
        'movers-v3: skipped malformed Swap logs'
      );
    }
    const decoded = usable.map((log) => ({
      pool: log.address.toLowerCase(),
      swap: decodeSwapLog(log),
      block: log.blockNumber ? Number(BigInt(log.blockNumber)) : 0,
    }));

    // 2. Resolve metadata (cache-first) only for the distinct pools that traded.
    //    This is where v3 forks and no-subject-token pools are filtered out.
    const pools = new Set(decoded.map((d) => d.pool));
    logger.info(
      { swaps: decoded.length, pools: pools.size },
      'movers-v3: window swept, resolving pool metadata'
    );
    const metaByPool: Map<string, PoolMeta> = await resolvePoolMetas(
      [...pools],
      state.meta,
      rpc.callMany
    );

    // 3. Aggregate (unanchored and non-canonical pools skipped) + rank.
    const aggregates = aggregateSwaps(decoded, metaByPool);
    if (aggregates.size === 0) {
      state.lastProcessedBlock = currentBlock;
      saveState(stateFile, state);
      logger.info({ fromBlock, currentBlock }, 'movers-v3: no anchored swaps in window');
      return { boards: [], fromBlock, toBlock: currentBlock };
    }

    // Record a 5-min candle sample and a volume sample for EVERY pool that traded
    // this window (continuity — not just the top-N), keyed by block-count bucket.
    const windowBlocks = currentBlock - fromBlock + 1;
    for (const [pool, agg] of aggregates) {
      const bucket = Math.floor(agg.lastBlock / BLOCKS_PER_CANDLE);
      // Volume history is recorded even when the price is unreadable — the spike
      // ranking needs a continuous baseline, and skipping a window here would
      // understate the pool's normal activity and inflate its next score. Recorded
      // in ANCHOR units, deliberately: see volume-history.ts.
      recordVolume(state.volumes, pool, bucket, agg.volumeAnchor, windowBlocks, BLOCKS_PER_CANDLE);
      if (agg.lastSqrtPriceX96 <= 0n) continue;
      const m = metaByPool.get(pool)!;
      const price = sqrtPriceToSeriesValue(agg.lastSqrtPriceX96, !m.anchorIsToken0);
      recordSwapPrice(state.candles, pool, bucket, price);
    }

    // 4. Resolve BNB/USD.
    //
    // This happens BEFORE ranking, unlike the Ethereum build where it was only
    // needed for market caps and could sit after the sort. Here it is needed by the
    // sort itself: rows on one board can be quoted in BNB or in any of three USD
    // stables, so ordering them requires a common currency. The pool's token0
    // ordering is derived, not hardcoded.
    //
    // A failure is far less damaging than the Ethereum build's equivalent: only
    // BNB-anchored rows lose their volume and market cap, while every stable-quoted
    // pool — the majority — is unaffected, because a BSC stable is 18 decimals and
    // its pool price is already a USD price.
    let anchorIsWbnbToken0: boolean | undefined;
    try {
      const raw = await rpc.call(WBNB_USDT_POOL, SEL_TOKEN0);
      if (hasWords(raw, 1)) anchorIsWbnbToken0 = addressAt(raw, 0) === WBNB;
    } catch (err) {
      logger.warn({ err }, 'movers-v3: WBNB/USDT token0() read failed');
    }
    state.bnbUsd ??= {};
    const bnbUsd =
      anchorIsWbnbToken0 != null
        ? await resolveBnbUsd(rpc.call, state.bnbUsd, Date.now(), anchorIsWbnbToken0)
        : undefined;

    // 5. Rank EVERY pool that traded, then walk down that order resolving market
    //    caps until both groups are full. Ranking all of them is required because
    //    which pools clear the threshold is unknowable until priced; the walk is
    //    what keeps that from costing one lookup per pool per cycle.
    //
    // WHAT the order is comes from RANK_BY — raw swap count by default, the volume
    // spike if configured. See config.ts for the trade-off.
    //
    // The spike is attached to every row either way, whichever mode is ranking.
    // The stdout renderer prints it, so why a row placed where it did stays
    // readable in the logs, and flipping RANK_BY then changes only the ORDER and
    // never what a row says about itself.
    //
    // Established tokens are dropped BEFORE the market-cap walk. They were not just
    // crowding the board, they were spending its lookup budget: each one consumed a
    // resolver call to establish a cap nobody needed, against a ceiling of 25.
    const withUsd = rankTopN(aggregates, aggregates.size)
      .map((r) => ({
        ...r,
        volumeUsd: toUsd(r.volumeAnchor, r.anchorKind, bnbUsd),
      }))
      // Second pass, not one literal: the spike's eligibility floor is denominated
      // in USD, so it needs the volumeUsd the pass above just computed.
      .map((r) => ({
        ...r,
        spike: spikeScore(state.volumes[r.pool], r.volumeAnchor, windowBlocks, r.volumeUsd),
      }));
    const ordered =
      RANK_BY === 'spike'
        ? sortBySpike(
            withUsd,
            (r) => r.spike,
            (r) => r.volumeUsd
          )
        : sortBySwaps(
            withUsd,
            (r) => r.swaps,
            (r) => r.volumeUsd
          );
    const { kept: ranked, dropped } = filterDenied(ordered);
    if (dropped) logger.debug({ dropped }, 'movers-v3: filtered established tokens');
    if (ranked.length === 0) {
      state.lastProcessedBlock = currentBlock;
      saveState(stateFile, state);
      logger.info({ dropped, fromBlock, currentBlock }, 'movers-v3: only established tokens traded');
      return { boards: [], fromBlock, toBlock: currentBlock };
    }

    // 5b. Split the ranking by quote currency — one list per board.
    //
    // The split happens HERE, after ranking and before the market-cap walk, and
    // both sides of that matter. Ranking first keeps each board's spike order
    // computed against the same window; splitting before the walk gives each board
    // its own TOP_N and its own lookup budget, so a quiet WBNB window cannot be
    // starved by a busy USDT one that spent the ceiling first.
    const byBoard = new Map<BoardKey, typeof ranked>();
    let unrouted = 0;
    for (const row of ranked) {
      const key = boardForAnchor(row.anchor);
      if (!key) {
        unrouted++; // quoted in USDC or USD1 — indexed, but on neither board
        continue;
      }
      const list = byBoard.get(key);
      if (list) list.push(row);
      else byBoard.set(key, [row]);
    }
    if (unrouted) {
      logger.debug({ unrouted }, 'movers-v3: pools on a non-board anchor (USDC/USD1)');
    }

    const resolveMarketCap = async (row: (typeof ranked)[number]): Promise<number | undefined> => {
      const agg = aggregates.get(row.pool);
      const meta = metaByPool.get(row.pool);
      if (!agg || !meta) return undefined;
      // A stable-anchored pool prices its token in USD directly, so it needs no
      // rate at all; only a BNB-anchored one depends on the read above.
      const anchorUsd = meta.anchorKind === 'usd' ? 1 : bnbUsd;
      if (anchorUsd == null) return undefined;
      const tm = await resolveTokenMeta(
        row.token,
        state.supplies,
        state.suppliesCheckedAt,
        rpc.callMany
      );
      if (!tm) return undefined;
      return computeFdvUsd({
        supply: tm.supply,
        tokenDecimals: tm.decimals,
        sqrtPriceX96: agg.lastSqrtPriceX96,
        tokenIsToken0: !meta.anchorIsToken0,
        anchorDecimals: ANCHOR_DECIMALS,
        anchorUsd,
      });
    };

    // 6. Value fees (slot0) + resolve symbols — only for rows that made a board.
    type Picked = Array<(typeof ranked)[number] & { marketCapUsd?: number }>;
    const buildRows = async (picked: Picked): Promise<MoversRow[]> => {
      const out: MoversRow[] = [];
      for (const r of picked) {
        const meta = metaByPool.get(r.pool)!;
        let feesAnchor = 0n;
        try {
          const raw = await rpc.call(r.pool, SEL_SLOT0);
          if (hasWords(raw, 1)) {
            feesAnchor = feesToAnchor(r.fees0, r.fees1, wordAt(raw, 0), meta.anchorIsToken0);
          }
        } catch (err) {
          logger.warn({ err, pool: r.pool }, 'movers-v3: slot0 fee valuation failed');
        }
        const candle = state.candles[r.pool];
        const series = candle ? [...candle.closes, candle.close] : [];
        const tag = r.volumeAnchor >= RSI_MIN_VOLUME_ANCHOR ? rsiForSeries(series) : undefined;
        const audit = await resolveAudit(r.token, state.audit, state.auditCheckedAt);
        out.push({
          pool: r.pool,
          token: r.token,
          symbol: await resolveSymbol(r.token),
          volumeUsd: r.volumeUsd,
          swaps: r.swaps,
          traders: r.traders,
          feesUsd: toUsd(feesAnchor, meta.anchorKind, bnbUsd),
          verified: audit?.verified,
          risk: audit?.risk,
          feeTier: formatFeeTier(meta.fee),
          rsi: tag?.rsi,
          rsiLabel: tag?.label,
          marketCapUsd: r.marketCapUsd,
          spike: r.spike,
        });
      }
      return out;
    };
    // 7. One market-cap walk and one row build per board, in BOARDS order.
    const boards: BoardResult[] = [];
    let lookups = 0;
    for (const { key, label } of BOARDS) {
      const rows = byBoard.get(key);
      if (!rows?.length) continue;
      const selection = await selectByMarketCap(rows, resolveMarketCap, {
        minUsd: MIN_MARKET_CAP_USD,
        perGroup: TOP_N,
        maxLookups: MCAP_MAX_LOOKUPS,
      });
      lookups += selection.lookups;
      // Hitting the ceiling is only NEWS when it cost the main board rows. The walk
      // stops when BOTH groups are full, and the Danger Zone rarely fills — most
      // tokens that trade clear the FDV gate — so a full main board plus a short
      // danger board is the normal shape of a healthy cycle, not a degraded one.
      // Warning on it unconditionally cried wolf every single cycle, which is worse
      // than silence: it trains you to ignore the one case that matters.
      if (selection.capped) {
        const short = selection.main.length < TOP_N;
        const detail = {
          board: key,
          lookups: selection.lookups,
          main: selection.main.length,
          danger: selection.danger.length,
        };
        if (short) {
          logger.warn(detail, 'movers-v3: lookup ceiling reached before the main board filled');
        } else {
          logger.debug(detail, 'movers-v3: lookup ceiling reached with the main board full');
        }
      }
      boards.push({
        key,
        label,
        main: await buildRows(selection.main),
        danger: await buildRows(selection.danger),
      });
    }

    state.lastProcessedBlock = currentBlock;
    saveState(stateFile, state);
    logger.info(
      {
        boards: boards.map((b) => ({ board: b.key, main: b.main.length, danger: b.danger.length })),
        pools: aggregates.size,
        unrouted,
        lookups,
        fromBlock,
        currentBlock,
      },
      'movers-v3: cycle complete'
    );
    return { boards, fromBlock, toBlock: currentBlock };
  } catch (err) {
    logger.error({ err }, 'movers-v3: cycle error');
    return undefined;
  } finally {
    cycleRunning = false;
  }
}
