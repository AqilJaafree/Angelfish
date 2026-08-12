import fs from 'fs';
import { V4PoolMeta } from './metadata';
import { CandleState } from '../candles';
import { VolumeState } from '../volume-history';
import { AuditResult } from '../../types';
import { TokenMeta } from '../onchain-mcap';
import { EthUsdState } from '../eth-price';

export interface V4MoversState {
  lastProcessedBlock: number;
  registry: Record<string, V4PoolMeta | null>; // poolId -> ETH metadata, or null
  registryCheckedAt: Record<string, number>; // poolId -> ms epoch (TTLs the negatives)
  symbols: Record<string, string>; // token -> symbol
  audit: Record<string, AuditResult>;
  auditCheckedAt: Record<string, number>;
  supplies: Record<string, TokenMeta>;
  suppliesCheckedAt: Record<string, number>;
  ethUsd?: EthUsdState;
  candles: Record<string, CandleState>; // poolId -> 5-min candle state
  volumes: Record<string, VolumeState>; // poolId -> bucketed volume, feeds the spike rank
}

function empty(): V4MoversState {
  return {
    lastProcessedBlock: 0,
    registry: {},
    registryCheckedAt: {},
    symbols: {},
    audit: {},
    auditCheckedAt: {},
    supplies: {},
    suppliesCheckedAt: {},
    candles: {},
    volumes: {},
  };
}

export function loadV4State(file: string): V4MoversState {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<V4MoversState>;
    return { ...empty(), ...s, ethUsd: s.ethUsd };
  } catch {
    return empty();
  }
}

export function saveV4State(file: string, state: V4MoversState): void {
  fs.writeFileSync(file, JSON.stringify(state));
}
