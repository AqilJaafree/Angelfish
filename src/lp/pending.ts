import { CONFIRM_TTL_MS } from './config';

export interface PendingPlan {
  code: string;
  createdAt: number;
  // Everything needed to replay the plan as a real execution.
  summary: string;
  steps: Array<{ label: string; contract: string; fn: string; args: string; value?: string; abi?: string }>;
}

// Quoted-but-unconfirmed plans, keyed by their confirm code.
//
// In memory on purpose: a plan must not survive a restart. The quote pins a tick
// range computed from a price read at quote time, and a code that still worked
// after a redeploy would let a stale range be minted long after the market moved.
const plans = new Map<string, PendingPlan>();

// Ambiguity-free alphabet: no O/0, I/1, so a code read off a phone screen and
// typed back cannot land on a different plan than the one intended.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

export function put(plan: Omit<PendingPlan, 'code' | 'createdAt'>, now = Date.now(), code = makeCode()): PendingPlan {
  const full: PendingPlan = { ...plan, code, createdAt: now };
  plans.set(code, full);
  return full;
}

// Single-use AND time-boxed. Taking a plan removes it, so a confirm code cannot
// be replayed to mint the same position twice — the failure mode that matters
// most here, because the second mint would succeed just as well as the first.
export function take(code: string, now = Date.now()): PendingPlan | { expired: true } | undefined {
  const plan = plans.get(code.toUpperCase().trim());
  if (!plan) return undefined;
  plans.delete(plan.code);
  if (now - plan.createdAt > CONFIRM_TTL_MS) return { expired: true };
  return plan;
}

export function clear(): void {
  plans.clear();
}

export function size(): number {
  return plans.size;
}
