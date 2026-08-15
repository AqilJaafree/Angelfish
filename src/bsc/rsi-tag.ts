import { computeRSI } from '../engine/rsi';

// RSI-14 needs period + 1 closes before it is meaningful. Below this, the row
// shows "warming up" rather than a fabricated value.
export const RSI_MIN_SAMPLES = 15;

export interface RsiTag {
  rsi: number;
  label?: 'oversold' | 'overbought';
}

// Undefined => not enough history yet (render as "RSI —").
export function rsiForSeries(series: number[]): RsiTag | undefined {
  if (series.length < RSI_MIN_SAMPLES) return undefined;
  // A perfectly flat series has no gains and no losses; computeRSI's avgLoss===0
  // short-circuit would otherwise report 100 (overbought) for zero movement.
  if (series.every((v) => v === series[0])) return { rsi: 50 };
  const rsi = Math.round(computeRSI(series, 14));
  const label = rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : undefined;
  return { rsi, label };
}
