import fs from 'fs';
import { PoolMeta } from './swaps';
import { CandleState } from '../candles';
import { AuditResult } from '../../types';
import { TokenMeta } from '../onchain-mcap';
import { EthUsdState } from '../eth-price';

export interface MoversState {
  lastProcessedBlock: number;
  meta: Record<string, PoolMeta | null>; // pool -> WETH metadata, or null
  symbols: Record<string, string>; // token -> symbol
  audit: Record<string, AuditResult>; // token -> cached verification + risk scan
  auditCheckedAt: Record<string, number>; // token -> ms epoch (TTLs the negatives)
  supplies: Record<string, TokenMeta>; // token -> { supply (string), decimals }
  suppliesCheckedAt: Record<string, number>; // token -> ms epoch (TTLs ALL entries)
  ethUsd?: EthUsdState;
  candles: Record<string, CandleState>; // pool -> 5-min candle state
}

function empty(): MoversState {
  return {
    lastProcessedBlock: 0,
    meta: {},
    symbols: {},
    audit: {},
    auditCheckedAt: {},
    supplies: {},
    suppliesCheckedAt: {},
    candles: {},
  };
}

export function loadState(file: string): MoversState {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MoversState>;
    return { ...empty(), ...s, ethUsd: s.ethUsd };
  } catch {
    return empty();
  }
}

export function saveState(file: string, state: MoversState): void {
  fs.writeFileSync(file, JSON.stringify(state));
}
