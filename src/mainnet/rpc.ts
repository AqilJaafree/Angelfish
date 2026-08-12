import { ETH_RPC_URL, RPC_TIMEOUT_MS, MAX_LOG_RANGE } from './config';
import { RawLog } from './decode';

let idCounter = 1;

export function isRetryableHttp(status: number): boolean {
  return status === 429 || status === 503;
}

// Range/result-size errors vary by provider: geth's "query returned more than N
// results", "range too large", timeouts, response-size caps, and blastapi's
// "You can make eth_getLogs requests with up to a 10 block range". Match broadly
// so the reactive split engages for providers whose cap is on RESULT COUNT (which
// the proactive chunking in getLogs cannot predict).
export function isSplittableError(message: string): boolean {
  return /timed out|exceed|too many|more than|response size|results|block range|range is too large|limit of/i.test(
    message
  );
}

export class RpcError extends Error {
  constructor(message: string, readonly rpcCode?: number) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcCall<T>(method: string, params: unknown[], tries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(ETH_RPC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // drpc.org answers the default undici UA with a bare 403. Sending a
          // browser UA costs nothing and keeps the endpoint list swappable.
          'user-agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: idCounter++, method, params }),
        // Fresh signal PER ATTEMPT. Hoisting this out of the loop would carry an
        // already-aborted signal into every retry, so the first timeout would kill
        // all remaining attempts instantly and the retry loop would be decorative.
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (isRetryableHttp(res.status)) {
        if (attempt >= tries - 1) throw new RpcError(`${method}: HTTP ${res.status}`);
        await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
      const json = (await res.json()) as {
        result?: T;
        error?: { message: string; code: number };
      };
      if (json.error) throw new RpcError(`${method}: ${json.error.message}`, json.error.code);
      return json.result as T;
    } catch (err) {
      // Network-level failures are retryable; RpcError (a JSON-RPC error) is not.
      if (err instanceof RpcError || attempt >= tries - 1) throw err;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
}

export async function blockNumber(): Promise<number> {
  return Number(BigInt(await rpcCall<string>('eth_blockNumber', [])));
}

export interface LogFilter {
  address?: string[];
  topics: (string | null)[];
  fromBlock: number;
  toBlock: number;
}

// One eth_getLogs, with the reactive bisection kept from the Robinhood build for
// providers that cap on RESULT COUNT rather than block span.
async function getLogsRaw(params: LogFilter): Promise<RawLog[]> {
  const filter: Record<string, unknown> = {
    topics: params.topics,
    fromBlock: '0x' + params.fromBlock.toString(16),
    toBlock: '0x' + params.toBlock.toString(16),
  };
  if (params.address) filter.address = params.address;
  try {
    return await rpcCall<RawLog[]>('eth_getLogs', [filter]);
  } catch (err) {
    if (
      err instanceof Error &&
      isSplittableError(err.message) &&
      params.toBlock > params.fromBlock
    ) {
      const mid = Math.floor((params.fromBlock + params.toBlock) / 2);
      const left = await getLogsRaw({ ...params, toBlock: mid });
      const right = await getLogsRaw({ ...params, fromBlock: mid + 1 });
      return left.concat(right);
    }
    throw err;
  }
}

// Split [fromBlock, toBlock] into inclusive windows of at most `size` blocks.
// Exported for its test: an off-by-one here silently drops or double-counts a
// block's swaps, which is invisible in aggregate output.
export function chunkRange(
  fromBlock: number,
  toBlock: number,
  size: number
): Array<{ fromBlock: number; toBlock: number }> {
  const span = Math.max(1, size);
  const out: Array<{ fromBlock: number; toBlock: number }> = [];
  for (let start = fromBlock; start <= toBlock; start += span) {
    out.push({ fromBlock: start, toBlock: Math.min(start + span - 1, toBlock) });
  }
  return out;
}

// eth_getLogs, chunked to MAX_LOG_RANGE up front. Sequential rather than
// concurrent: free endpoints rate-limit aggressively, and a burst of parallel
// chunks trades one slow cycle for a 429 storm that costs more.
export async function getLogs(params: LogFilter): Promise<RawLog[]> {
  const windows = chunkRange(params.fromBlock, params.toBlock, MAX_LOG_RANGE);
  const out: RawLog[] = [];
  for (const w of windows) {
    out.push(...(await getLogsRaw({ ...params, ...w })));
  }
  return out;
}

export async function call(to: string, data: string): Promise<string> {
  return rpcCall<string>('eth_call', [{ to, data }, 'latest']);
}
