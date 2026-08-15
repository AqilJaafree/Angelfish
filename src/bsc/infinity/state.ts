import fs from 'fs';
import { ClPoolMeta } from './metadata';
import { CandleState } from '../candles';
import { VolumeState } from '../volume-history';
import { AuditResult } from '../../types';
import { TokenMeta } from '../onchain-mcap';
import { BnbUsdState } from '../bnb-price';

export interface ClMoversState {
  lastProcessedBlock: number;
  registry: Record<string, ClPoolMeta | null>; // poolId -> anchor metadata, or null
  registryCheckedAt: Record<string, number>; // poolId -> ms epoch (TTLs the negatives)
  symbols: Record<string, string>; // token -> symbol
  audit: Record<string, AuditResult>;
  auditCheckedAt: Record<string, number>;
  supplies: Record<string, TokenMeta>;
  suppliesCheckedAt: Record<string, number>;
  bnbUsd?: BnbUsdState;
  candles: Record<string, CandleState>; // poolId -> 5-min candle state
  volumes: Record<string, VolumeState>; // poolId -> bucketed volume, feeds the spike rank
}

function empty(): ClMoversState {
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

export function loadClState(file: string): ClMoversState {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ClMoversState>;
    return { ...empty(), ...s, bnbUsd: s.bnbUsd };
  } catch {
    return empty();
  }
}

export function saveClState(file: string, state: ClMoversState): void {
  fs.writeFileSync(file, JSON.stringify(state));
}
