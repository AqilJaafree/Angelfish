import { logger } from '../../logger';
import * as rpc from '../rpc';
import { addressAt, decodeSymbol, hasWords } from '../decode';
import {
  SEL_SYMBOL,
  SEL_TOKEN0,
  BLOCKS_PER_CANDLE,
  RSI_MIN_VOLUME_ANCHOR,
  MIN_MARKET_CAP_USD,
  MCAP_MAX_LOOKUPS,
  ANCHOR_DECIMALS,
  WBNB,
  WBNB_USDT_POOL,
  CL_POOL_MANAGER,
  CL_SWAP_TOPIC0,
  TOP_N,
  MAX_LOOKBACK_BLOCKS,
} from '../config';
import { toUsd } from '../anchors';
import { decodeClSwapLog } from './decode';
import { aggregateClSwaps, rankClTopN } from './swaps';
import { resolveClPoolMetas, ClPoolMeta } from './metadata';
import { loadClState, saveClState, ClMoversState } from './state';
import { resolveAudit } from '../audit';
import { formatFeeTier } from '../format';
import { MoversRow } from '../../types';
import { sqrtPriceToSeriesValue } from '../price';
import { recordSwapPrice } from '../candles';
import { recordVolume, spikeScore, sortBySpike } from '../volume-history';
import { rsiForSeries } from '../rsi-tag';
import { resolveTokenMeta, computeFdvUsd } from '../onchain-mcap';
import { resolveBnbUsd } from '../bnb-price';
import { selectByMarketCap } from '../mcap-select';
import { filterDenied } from '../denylist';

let stateFile = '';
let state: ClMoversState;

export function initMoversCl(file: string): void {
  stateFile = file;
  state = loadClState(file);
}

async function resolveSymbol(token: string): Promise<string> {
  const cached = state.symbols[token];
  if (cached) return cached;
  try {
    const decoded = decodeSymbol(await rpc.call(token, SEL_SYMBOL));
    if (decoded) {
      state.symbols[token] = decoded;
      return decoded;
    }
  } catch (err) {
    logger.warn({ err, token }, 'movers-cl: symbol() failed, using address fallback');
  }
  return token.slice(0, 8);
}

let cycleRunning = false;

export interface CycleResult {
  main: MoversRow[];
  danger: MoversRow[];
  fromBlock: number;
  toBlock: number;
}

export async function moversCycleCl(): Promise<CycleResult | undefined> {
  if (cycleRunning) {
    logger.warn('movers-cl: previous cycle still running, skipping this tick');
    return undefined;
  }
  cycleRunning = true;
  try {
    const currentBlock = await rpc.blockNumber();

    let fromBlock = state.lastProcessedBlock + 1;
    if (
      state.lastProcessedBlock === 0 ||
      currentBlock - state.lastProcessedBlock > MAX_LOOKBACK_BLOCKS
    ) {
      fromBlock = Math.max(1, currentBlock - MAX_LOOKBACK_BLOCKS + 1);
      if (state.lastProcessedBlock > 0 && fromBlock > state.lastProcessedBlock + 1) {
        logger.warn(
          { skippedFrom: state.lastProcessedBlock + 1, resumedFrom: fromBlock },
          'movers-cl: downtime clamp, skipping blocks'
        );
      }
    }
    if (currentBlock < fromBlock) {
      saveClState(stateFile, state);
      return undefined;
    }

    // 1. Sweep Infinity CL Swap logs from the CLPoolManager singleton. One address,
    //    one topic — every Infinity concentrated-liquidity pool trades through it.
    //
    //    Because this filter names an address, it runs on the DEFAULT endpoint and
    //    at a much larger chunk size than the v3 sweep: the restriction the v3 path
    //    fights (see config.ts) is specifically on topic-only queries, and an
    //    address-filtered 300-block window comes back in a single call.
    //
    // Announced before it runs, for the reason given in the v3 worker: a cold start
    // is minutes of sequential work that would otherwise log nothing.
    logger.info(
      { fromBlock, toBlock: currentBlock, blocks: currentBlock - fromBlock + 1 },
      'movers-cl: sweeping window'
    );
    const logs = await rpc.getLogs({
      address: [CL_POOL_MANAGER],
      topics: [CL_SWAP_TOPIC0],
      fromBlock,
      toBlock: currentBlock,
      maxRange: MAX_LOOKBACK_BLOCKS,
    });
    // Defensive: a well-formed CL Swap has [topic0, poolId, sender] — drop anything
    // shorter so decode can't throw and wedge the cursor on this window.
    const usable = logs.filter((log) => log.topics.length >= 3);
    if (usable.length !== logs.length) {
      logger.warn(
        { dropped: logs.length - usable.length },
        'movers-cl: skipped malformed Swap logs'
      );
    }
    const decoded = usable.map((log) => ({
      poolId: log.topics[1],
      swap: decodeClSwapLog(log),
      block: log.blockNumber ? Number(BigInt(log.blockNumber)) : 0,
    }));

    // 2. Resolve metadata (cache-first) for the distinct pools that traded.
    //
    // There is NO Initialize-log indexing step here, unlike the Ethereum build. That
    // step exists there to cover the pools Uniswap v4's PositionManager mapping
    // misses; Infinity's mapping lives on the PoolManager itself and covered 107 of
    // 107 live PoolIds when measured, so a second source would have nothing to catch
    // and would cost an extra getLogs per cycle. See metadata.ts.
    const poolIds = new Set(decoded.map((d) => d.poolId));
    logger.info(
      { swaps: decoded.length, pools: poolIds.size },
      'movers-cl: window swept, resolving pool metadata'
    );
    const now = Date.now();
    const metaById: Map<string, ClPoolMeta> = await resolveClPoolMetas(
      [...poolIds],
      state.registry,
      state.registryCheckedAt,
      rpc.callMany,
      now
    );

    // 3. Aggregate (unanchored pools skipped) + rank. Fees come from the events — no
    //    slot0 call needed, unlike v3.
    const aggregates = aggregateClSwaps(decoded, metaById);
    if (aggregates.size === 0) {
      state.lastProcessedBlock = currentBlock;
      saveClState(stateFile, state);
      logger.info({ fromBlock, currentBlock }, 'movers-cl: no anchored swaps in window');
      return { main: [], danger: [], fromBlock, toBlock: currentBlock };
    }

    const windowBlocks = currentBlock - fromBlock + 1;
    for (const [poolId, agg] of aggregates) {
      const bucket = Math.floor(agg.lastBlock / BLOCKS_PER_CANDLE);
      // Recorded even when the price is unreadable — see the v3 worker: a gap in the
      // volume history understates the baseline and inflates the next score.
      recordVolume(
        state.volumes,
        poolId,
        bucket,
        agg.volumeAnchor,
        windowBlocks,
        BLOCKS_PER_CANDLE
      );
      if (agg.lastSqrtPriceX96 <= 0n) continue;
      const m = metaById.get(poolId)!;
      const price = sqrtPriceToSeriesValue(agg.lastSqrtPriceX96, !m.anchorIsCurrency0);
      recordSwapPrice(state.candles, poolId, bucket, price);
    }

    // 4. BNB/USD, before the ranking that needs it — see the v3 worker. The anchor
    //    pool is a v3 pool, and ClMoversState has no v3-style PoolMeta cache (its
    //    `registry` holds ClPoolMeta, a different shape keyed by poolId), so its
    //    token0() ordering is read directly here rather than forced through a cache
    //    shape that doesn't fit.
    let anchorIsWbnbToken0: boolean | undefined;
    try {
      const raw = await rpc.call(WBNB_USDT_POOL, SEL_TOKEN0);
      if (hasWords(raw, 1)) anchorIsWbnbToken0 = addressAt(raw, 0) === WBNB;
    } catch (err) {
      logger.warn({ err }, 'movers-cl: WBNB/USDT token0() read failed');
    }
    state.bnbUsd ??= {};
    const bnbUsd =
      anchorIsWbnbToken0 != null
        ? await resolveBnbUsd(rpc.call, state.bnbUsd, now, anchorIsWbnbToken0)
        : undefined;

    // Ranked by volume spike against each pool's own baseline, then established
    // tokens dropped before the market-cap walk — see the v3 worker for both.
    const withUsd = rankClTopN(aggregates, aggregates.size).map((r) => ({
      ...r,
      volumeUsd: toUsd(r.volumeAnchor, r.anchorKind, bnbUsd),
    }));
    const scoredRanked = sortBySpike(
      withUsd,
      (r) => spikeScore(state.volumes[r.poolId], r.volumeAnchor, windowBlocks, r.volumeUsd),
      (r) => r.volumeUsd
    );
    const { kept: ranked, dropped } = filterDenied(scoredRanked);
    if (dropped) logger.debug({ dropped }, 'movers-cl: filtered established tokens');
    if (ranked.length === 0) {
      state.lastProcessedBlock = currentBlock;
      saveClState(stateFile, state);
      logger.info({ dropped, fromBlock, currentBlock }, 'movers-cl: only established tokens traded');
      return { main: [], danger: [], fromBlock, toBlock: currentBlock };
    }
    const selection = await selectByMarketCap(
      ranked,
      async (row) => {
        const agg = aggregates.get(row.poolId);
        const meta = metaById.get(row.poolId);
        if (!agg || !meta) return undefined;
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
          tokenIsToken0: !meta.anchorIsCurrency0,
          anchorDecimals: ANCHOR_DECIMALS,
          anchorUsd,
        });
      },
      { minUsd: MIN_MARKET_CAP_USD, perGroup: TOP_N, maxLookups: MCAP_MAX_LOOKUPS }
    );
    if (selection.capped) {
      logger.warn(
        { lookups: selection.lookups, main: selection.main.length, danger: selection.danger.length },
        'movers-cl: market-cap lookup ceiling reached, board may be incomplete'
      );
    }

    const buildRows = async (picked: typeof selection.main): Promise<MoversRow[]> => {
      const out: MoversRow[] = [];
      for (const r of picked) {
        const meta = metaById.get(r.poolId)!;
        const candle = state.candles[r.poolId];
        const series = candle ? [...candle.closes, candle.close] : [];
        const tag = r.volumeAnchor >= RSI_MIN_VOLUME_ANCHOR ? rsiForSeries(series) : undefined;
        const audit = await resolveAudit(r.token, state.audit, state.auditCheckedAt);
        out.push({
          pool: r.poolId,
          token: r.token,
          symbol: await resolveSymbol(r.token),
          volumeUsd: r.volumeUsd,
          swaps: r.swaps,
          traders: r.traders,
          feesUsd: toUsd(r.feesAnchor, meta.anchorKind, bnbUsd),
          verified: audit?.verified,
          risk: audit?.risk,
          // From the rate the last swap actually paid, not from the PoolKey — see
          // ClPoolAggregate.lastFeePips. Undefined when no plausible fee was seen,
          // which renders as no tier at all rather than a fabricated 0%.
          feeTier: r.lastFeePips != null ? formatFeeTier(Number(r.lastFeePips)) : undefined,
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
    saveClState(stateFile, state);
    logger.info(
      {
        main: main.length,
        danger: danger.length,
        pools: aggregates.size,
        lookups: selection.lookups,
        fromBlock,
        currentBlock,
      },
      'movers-cl: cycle complete'
    );
    return { main, danger, fromBlock, toBlock: currentBlock };
  } catch (err) {
    logger.error({ err }, 'movers-cl: cycle error');
    return undefined;
  } finally {
    cycleRunning = false;
  }
}
