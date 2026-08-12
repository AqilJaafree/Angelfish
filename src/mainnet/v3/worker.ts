import { logger } from '../../logger';
import * as rpc from '../rpc';
import { decodeSwapLog, decodeSymbol, hasWords, wordAt } from '../decode';
import { aggregateSwaps, feesToWeth, rankTopN, PoolMeta } from './swaps';
import { resolvePoolMeta } from './metadata';
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
  RSI_MIN_VOLUME_WEI,
  MIN_MARKET_CAP_USD,
  MCAP_MAX_LOOKUPS,
  USDC_WETH_POOL,
  WETH,
} from '../config';
import { sqrtPriceToSeriesValue } from '../price';
import { recordSwapPrice } from '../candles';
import { recordVolume, spikeScore, sortBySpike } from '../volume-history';
import { rsiForSeries } from '../rsi-tag';
import { resolveTokenMeta, computeFdvUsd } from '../onchain-mcap';
import { resolveEthUsd } from '../eth-price';
import { selectByMarketCap } from '../mcap-select';
import { filterDenied } from '../denylist';
import { addressAt } from '../decode';

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

export interface CycleResult {
  main: MoversRow[];
  danger: MoversRow[];
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

    // 1. Sweep ALL v3 Swap logs in the window. No address filter — the pool set is
    //    discovered from the logs themselves, which is what makes a newly-created
    //    pool visible on its very first trade. rpc.getLogs chunks the range to the
    //    provider's cap.
    //
    // Announce the sweep BEFORE it runs. A cold start clamps to
    // MAX_LOOKBACK_BLOCKS, which at a 10-block chunk cap is 30 sequential
    // requests followed by a few hundred pool resolutions — minutes of work.
    // Without this line that whole stretch emits nothing at all, and a slow
    // endpoint is indistinguishable from a hung process for as long as it lasts.
    logger.info(
      { fromBlock, toBlock: currentBlock, blocks: currentBlock - fromBlock + 1 },
      'movers-v3: sweeping window'
    );
    const logs = await rpc.getLogs({
      topics: [V3_SWAP_TOPIC0],
      fromBlock,
      toBlock: currentBlock,
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
    //    This is where v3 forks and non-WETH pools are filtered out.
    const pools = new Set(decoded.map((d) => d.pool));
    logger.info(
      { swaps: decoded.length, pools: pools.size },
      'movers-v3: window swept, resolving pool metadata'
    );
    const metaByPool = new Map<string, PoolMeta>();
    for (const pool of pools) {
      const meta = await resolvePoolMeta(pool, state.meta, rpc.call);
      if (meta) metaByPool.set(pool, meta);
    }

    // 3. Aggregate (non-WETH and non-canonical pools skipped) + rank.
    const aggregates = aggregateSwaps(decoded, metaByPool);
    if (aggregates.size === 0) {
      state.lastProcessedBlock = currentBlock;
      saveState(stateFile, state);
      logger.info({ fromBlock, currentBlock }, 'movers-v3: no WETH swaps in window');
      return { main: [], danger: [], fromBlock, toBlock: currentBlock };
    }

    // Record a 5-min candle sample and a volume sample for EVERY pool that
    // traded this window (continuity — not just the top-N), keyed by
    // block-count bucket.
    const windowBlocks = currentBlock - fromBlock + 1;
    for (const [pool, agg] of aggregates) {
      const bucket = Math.floor(agg.lastBlock / BLOCKS_PER_CANDLE);
      // Volume history is recorded even when the price is unreadable — the
      // spike ranking needs a continuous baseline, and skipping a window here
      // would understate the pool's normal activity and inflate its next score.
      recordVolume(state.volumes, pool, bucket, agg.volumeWeth, windowBlocks, BLOCKS_PER_CANDLE);
      if (agg.lastSqrtPriceX96 <= 0n) continue;
      const m = metaByPool.get(pool)!;
      const price = sqrtPriceToSeriesValue(agg.lastSqrtPriceX96, !m.wethIsToken0);
      recordSwapPrice(state.candles, pool, bucket, price);
    }

    // 4. Rank EVERY pool that traded, then walk down that order resolving market
    //    caps until both groups are full. Ranking all of them is required
    //    because which pools clear the threshold is unknowable until priced; the
    //    walk is what keeps that from costing one lookup per pool per cycle.
    //
    // Established tokens are dropped BEFORE that walk. They were not just
    // crowding the board, they were spending its lookup budget: each one
    // consumed a resolver call to establish a $49B cap nobody needed, against a
    // ceiling of 25 per cycle.
    //
    // Rank by how far each pool is trading above its OWN recent baseline, not
    // by absolute volume. Absolute volume is near-constant per pool — the
    // biggest pool is the biggest pool on almost every window — so ranking on
    // it reports the same handful of names forever. Pools without enough
    // history to score fall back to volume order behind the scored ones.
    const scoredRanked = sortBySpike(
      rankTopN(aggregates, aggregates.size),
      (r) => spikeScore(state.volumes[r.pool], r.volumeWeth, windowBlocks),
      (r) => r.volumeWeth
    );
    const { kept: ranked, dropped } = filterDenied(scoredRanked);
    if (dropped) logger.debug({ dropped }, 'movers-v3: filtered established tokens');
    if (ranked.length === 0) {
      state.lastProcessedBlock = currentBlock;
      saveState(stateFile, state);
      logger.info({ dropped, fromBlock, currentBlock }, 'movers-v3: only established tokens traded');
      return { main: [], danger: [], fromBlock, toBlock: currentBlock };
    }
    // One slot0 read on the USDC/WETH pool prices the whole board. If it fails,
    // every cap this cycle is unknown and every row lands in Danger Zone — loudly,
    // via the warn inside resolveEthUsd — rather than against a stale rate. The
    // pool's token0 ordering is derived, not hardcoded.
    let anchorIsWethToken0: boolean | undefined;
    try {
      const raw = await rpc.call(USDC_WETH_POOL, SEL_TOKEN0);
      if (hasWords(raw, 1)) anchorIsWethToken0 = addressAt(raw, 0) === WETH;
    } catch (err) {
      logger.warn({ err }, 'movers-v3: USDC/WETH token0() read failed');
    }
    state.ethUsd ??= {};
    const anchorUsd =
      anchorIsWethToken0 != null
        ? await resolveEthUsd(rpc.call, state.ethUsd, Date.now(), anchorIsWethToken0)
        : undefined;
    const selection = await selectByMarketCap(
      ranked,
      async (row) => {
        if (anchorUsd == null) return undefined;
        const agg = aggregates.get(row.pool);
        const meta = metaByPool.get(row.pool);
        if (!agg || !meta) return undefined;
        const tm = await resolveTokenMeta(
          row.token,
          state.supplies,
          state.suppliesCheckedAt,
          rpc.call
        );
        if (!tm) return undefined;
        return computeFdvUsd({
          supply: tm.supply,
          tokenDecimals: tm.decimals,
          sqrtPriceX96: agg.lastSqrtPriceX96,
          tokenIsToken0: !meta.wethIsToken0,
          anchorDecimals: 18,
          anchorUsd,
        });
      },
      { minUsd: MIN_MARKET_CAP_USD, perGroup: TOP_N, maxLookups: MCAP_MAX_LOOKUPS }
    );
    if (selection.capped) {
      logger.warn(
        { lookups: selection.lookups, main: selection.main.length, danger: selection.danger.length },
        'movers-v3: market-cap lookup ceiling reached, board may be incomplete'
      );
    }

    // 5. Value fees (slot0) + resolve symbols — only for rows that made a board.
    const buildRows = async (picked: typeof selection.main): Promise<MoversRow[]> => {
      const out: MoversRow[] = [];
      for (const r of picked) {
        const meta = metaByPool.get(r.pool)!;
        let feesWeth = 0n;
        try {
          const raw = await rpc.call(r.pool, SEL_SLOT0);
          if (hasWords(raw, 1)) {
            feesWeth = feesToWeth(r.fees0, r.fees1, wordAt(raw, 0), meta.wethIsToken0);
          }
        } catch (err) {
          logger.warn({ err, pool: r.pool }, 'movers-v3: slot0 fee valuation failed');
        }
        const candle = state.candles[r.pool];
        const series = candle ? [...candle.closes, candle.close] : [];
        const tag = r.volumeWeth >= RSI_MIN_VOLUME_WEI ? rsiForSeries(series) : undefined;
        const audit = await resolveAudit(r.token, state.audit, state.auditCheckedAt);
        out.push({
          pool: r.pool,
          token: r.token,
          symbol: await resolveSymbol(r.token),
          volumeWeth: r.volumeWeth,
          swaps: r.swaps,
          traders: r.traders,
          feesWeth,
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
    const main = await buildRows(selection.main);
    const danger = await buildRows(selection.danger);


    state.lastProcessedBlock = currentBlock;
    saveState(stateFile, state);
    logger.info(
      {
        main: main.length,
        danger: danger.length,
        pools: aggregates.size,
        lookups: selection.lookups,
        fromBlock,
        currentBlock,
      },
      'movers-v3: cycle complete'
    );
    return { main, danger, fromBlock, toBlock: currentBlock };
  } catch (err) {
    logger.error({ err }, 'movers-v3: cycle error');
    return undefined;
  } finally {
    cycleRunning = false;
  }
}
