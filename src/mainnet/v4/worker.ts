import { logger } from '../../logger';
import * as rpc from '../rpc';
import { addressAt, decodeSymbol, hasWords } from '../decode';
import {
  SEL_SYMBOL,
  SEL_TOKEN0,
  BLOCKS_PER_CANDLE,
  RSI_MIN_VOLUME_WEI,
  MIN_MARKET_CAP_USD,
  MCAP_MAX_LOOKUPS,
  WETH,
  USDC_WETH_POOL,
  V4_POOL_MANAGER,
  V4_SWAP_TOPIC0,
  V4_INITIALIZE_TOPIC0,
  V4_DYNAMIC_FEE_FLAG,
  TOP_N,
  MAX_LOOKBACK_BLOCKS,
} from '../config';
import { decodeV4SwapLog } from './decode';
import { aggregateV4Swaps, rankV4TopN } from './swaps';
import { resolveV4PoolMeta, indexInitializeLogs, V4PoolMeta } from './metadata';
import { loadV4State, saveV4State, V4MoversState } from './state';
import { resolveAudit } from '../audit';
import { formatFeeTier } from '../format';
import { MoversRow } from '../../types';
import { sqrtPriceToSeriesValue } from '../price';
import { recordSwapPrice } from '../candles';
import { rsiForSeries } from '../rsi-tag';
import { resolveTokenMeta, computeFdvUsd } from '../onchain-mcap';
import { resolveEthUsd } from '../eth-price';
import { selectByMarketCap } from '../mcap-select';

let stateFile = '';
let state: V4MoversState;

export function initMoversV4(file: string): void {
  stateFile = file;
  state = loadV4State(file);
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
    logger.warn({ err, token }, 'movers-v4: symbol() failed, using address fallback');
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

export async function moversCycleV4(): Promise<CycleResult | undefined> {
  if (cycleRunning) {
    logger.warn('movers-v4: previous cycle still running, skipping this tick');
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
          'movers-v4: downtime clamp, skipping blocks'
        );
      }
    }
    if (currentBlock < fromBlock) {
      saveV4State(stateFile, state);
      return undefined;
    }

    // 1. Sweep v4 Swap logs from the PoolManager singleton. One address, one
    //    topic — every v4 pool on the chain trades through this contract.
    //
    // Announced before it runs, for the reason given in the v3 worker: a cold
    // start is minutes of sequential work that would otherwise log nothing.
    logger.info(
      { fromBlock, toBlock: currentBlock, blocks: currentBlock - fromBlock + 1 },
      'movers-v4: sweeping window'
    );
    const logs = await rpc.getLogs({
      address: [V4_POOL_MANAGER],
      topics: [V4_SWAP_TOPIC0],
      fromBlock,
      toBlock: currentBlock,
    });
    // Defensive: a well-formed v4 Swap has [topic0, poolId, sender] — drop
    // anything shorter so decode can't throw and wedge the cursor on this window.
    const usable = logs.filter((log) => log.topics.length >= 3);
    if (usable.length !== logs.length) {
      logger.warn(
        { dropped: logs.length - usable.length },
        'movers-v4: skipped malformed Swap logs'
      );
    }
    const decoded = usable.map((log) => ({
      poolId: log.topics[1],
      swap: decodeV4SwapLog(log),
      block: log.blockNumber ? Number(BigInt(log.blockNumber)) : 0,
    }));

    // 2. Index any pools CREATED in this same window, before resolving. A pool's
    //    first trade can land in the same window as its Initialize, and the
    //    Initialize log carries the currencies directly — cheaper and more
    //    authoritative than the poolKeys read, and it also covers pools
    //    initialized without going through PositionManager.
    try {
      const initLogs = await rpc.getLogs({
        address: [V4_POOL_MANAGER],
        topics: [V4_INITIALIZE_TOPIC0],
        fromBlock,
        toBlock: currentBlock,
      });
      const added = indexInitializeLogs(state.registry, initLogs);
      if (added) logger.info({ added }, 'movers-v4: indexed newly initialized pools');
    } catch (err) {
      // Non-fatal: resolveV4PoolMeta's poolKeys read covers almost every pool.
      logger.warn({ err }, 'movers-v4: Initialize sweep failed, falling back to poolKeys');
    }

    // 3. Resolve metadata (cache-first) for the distinct pools that traded.
    const poolIds = new Set(decoded.map((d) => d.poolId));
    logger.info(
      { swaps: decoded.length, pools: poolIds.size },
      'movers-v4: window swept, resolving pool metadata'
    );
    const metaById = new Map<string, V4PoolMeta>();
    const now = Date.now();
    for (const poolId of poolIds) {
      const meta = await resolveV4PoolMeta(
        poolId,
        state.registry,
        state.registryCheckedAt,
        rpc.call,
        now
      );
      if (meta) metaById.set(poolId, meta);
    }

    // 4. Aggregate (non-ETH pools skipped) + rank. Fees come from the events — no
    //    slot0 call needed, unlike v3.
    const aggregates = aggregateV4Swaps(decoded, metaById);
    if (aggregates.size === 0) {
      state.lastProcessedBlock = currentBlock;
      saveV4State(stateFile, state);
      logger.info({ fromBlock, currentBlock }, 'movers-v4: no ETH swaps in window');
      return { main: [], danger: [], fromBlock, toBlock: currentBlock };
    }

    for (const [poolId, agg] of aggregates) {
      if (agg.lastSqrtPriceX96 <= 0n) continue;
      const m = metaById.get(poolId)!;
      const price = sqrtPriceToSeriesValue(agg.lastSqrtPriceX96, !m.ethIsCurrency0);
      recordSwapPrice(state.candles, poolId, Math.floor(agg.lastBlock / BLOCKS_PER_CANDLE), price);
    }

    const ranked = rankV4TopN(aggregates, aggregates.size);
    // The ETH/USD anchor is a v3 pool, and V4MoversState has no v3-style PoolMeta
    // cache (its `registry` holds V4PoolMeta, a different shape keyed by poolId) —
    // so its token0() ordering is read directly here rather than forced through a
    // cache shape that doesn't fit.
    let anchorIsWethToken0: boolean | undefined;
    try {
      const raw = await rpc.call(USDC_WETH_POOL, SEL_TOKEN0);
      if (hasWords(raw, 1)) anchorIsWethToken0 = addressAt(raw, 0) === WETH;
    } catch (err) {
      logger.warn({ err }, 'movers-v4: USDC/WETH token0() read failed');
    }
    state.ethUsd ??= {};
    const anchorUsd =
      anchorIsWethToken0 != null
        ? await resolveEthUsd(rpc.call, state.ethUsd, now, anchorIsWethToken0)
        : undefined;
    const selection = await selectByMarketCap(
      ranked,
      async (row) => {
        if (anchorUsd == null) return undefined;
        const agg = aggregates.get(row.poolId);
        const meta = metaById.get(row.poolId);
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
          tokenIsToken0: !meta.ethIsCurrency0,
          anchorDecimals: 18,
          anchorUsd,
        });
      },
      { minUsd: MIN_MARKET_CAP_USD, perGroup: TOP_N, maxLookups: MCAP_MAX_LOOKUPS }
    );
    if (selection.capped) {
      logger.warn(
        { lookups: selection.lookups, main: selection.main.length, danger: selection.danger.length },
        'movers-v4: market-cap lookup ceiling reached, board may be incomplete'
      );
    }

    const buildRows = async (picked: typeof selection.main): Promise<MoversRow[]> => {
      const out: MoversRow[] = [];
      for (const r of picked) {
        const meta = metaById.get(r.poolId)!;
        // 0x800000 is v4's dynamic-fee flag — such pools have no fixed tier.
        const feeTier = meta.fee >= V4_DYNAMIC_FEE_FLAG ? 'dynamic' : formatFeeTier(meta.fee);
        const candle = state.candles[r.poolId];
        const series = candle ? [...candle.closes, candle.close] : [];
        const tag = r.volumeEth >= RSI_MIN_VOLUME_WEI ? rsiForSeries(series) : undefined;
        const audit = await resolveAudit(r.token, state.audit, state.auditCheckedAt);
        out.push({
          pool: r.poolId,
          token: r.token,
          symbol: await resolveSymbol(r.token),
          volumeWeth: r.volumeEth,
          swaps: r.swaps,
          traders: r.traders,
          feesWeth: r.feesEth,
          verified: audit?.verified,
          risk: audit?.risk,
          feeTier,
          rsi: tag?.rsi,
          rsiLabel: tag?.label,
          marketCapUsd: r.marketCapUsd,
        });
      }
      return out;
    };
    const main = await buildRows(selection.main);
    const danger = await buildRows(selection.danger);


    state.lastProcessedBlock = currentBlock;
    saveV4State(stateFile, state);
    logger.info(
      {
        main: main.length,
        danger: danger.length,
        pools: aggregates.size,
        lookups: selection.lookups,
        fromBlock,
        currentBlock,
      },
      'movers-v4: cycle complete'
    );
    return { main, danger, fromBlock, toBlock: currentBlock };
  } catch (err) {
    logger.error({ err }, 'movers-v4: cycle error');
    return undefined;
  } finally {
    cycleRunning = false;
  }
}
