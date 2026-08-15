import { BSC_RPC_URL, BSC_LOG_RPC_URL, RPC_TIMEOUT_MS, MAX_LOG_RANGE } from './config';
import { RawLog } from './decode';

let idCounter = 1;

export function isRetryableHttp(status: number): boolean {
  return status === 429 || status === 503;
}

// Range/result-size errors vary by provider: geth's "query returned more than N
// results", "range too large", timeouts, response-size caps, blockrazor's "log query
// range must not exceed 25 blocks" and 1rpc's "eth_getLogs is limited to 0 - 50 blocks
// range". Match broadly so the reactive split engages for providers whose cap is on
// RESULT COUNT (which the proactive chunking in getLogs cannot predict).
//
// `limited to` earns its place: 1rpc.io/bnb is one of only two BSC endpoints that
// answer a topic-only query at all, so it is a documented choice for BSC_LOG_RPC_URL —
// and its message matches none of the other alternatives here ("blocks range", not
// "block range"; "limited to", not "limit of").
export function isSplittableError(message: string): boolean {
  return /timed out|exceed|too many|more than|response size|results|blocks? range|range is too large|limit of|limited to/i.test(
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

// Some BSC endpoints signal rate limiting INSIDE a 200 response as a JSON-RPC
// error rather than an HTTP 429 — blockrazor answers `{"code":429,"message":"too
// many requests"}` with a 200 status. RpcError is otherwise treated as permanent
// and never retried, so without this the sweep would abort a whole cycle on what
// is really a back-off signal.
export function isRetryableRpcError(code: number | undefined, message: string): boolean {
  return code === 429 || code === -32005 || /too many requests|rate.?limit/i.test(message);
}

async function rpcCall<T>(
  method: string,
  params: unknown[],
  tries = 6,
  url: string = BSC_RPC_URL
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
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
      if (json.error) {
        if (isRetryableRpcError(json.error.code, json.error.message) && attempt < tries - 1) {
          await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
          continue;
        }
        throw new RpcError(`${method}: ${json.error.message}`, json.error.code);
      }
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
  // Which endpoint to sweep from. Defaults to BSC_RPC_URL; the v3 worker overrides
  // it with BSC_LOG_RPC_URL because only that endpoint answers a topic-only query.
  endpoint?: string;
  // Chunk size for this sweep. Defaults to MAX_LOG_RANGE (25, the topic-only
  // provider's cap). An ADDRESS-FILTERED sweep is far cheaper for the node and
  // publicnode serves 300 blocks of it in one call, so the Infinity worker raises
  // this rather than paying 12 round-trips for a window it could fetch in one.
  maxRange?: number;
}

// One eth_getLogs, with the reactive bisection kept for providers that cap on
// RESULT COUNT rather than block span.
async function getLogsRaw(params: LogFilter): Promise<RawLog[]> {
  const filter: Record<string, unknown> = {
    topics: params.topics,
    fromBlock: '0x' + params.fromBlock.toString(16),
    toBlock: '0x' + params.toBlock.toString(16),
  };
  if (params.address) filter.address = params.address;
  try {
    return await rpcCall<RawLog[]>('eth_getLogs', [filter], 6, params.endpoint ?? BSC_RPC_URL);
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
  const windows = chunkRange(params.fromBlock, params.toBlock, params.maxRange ?? MAX_LOG_RANGE);
  const out: RawLog[] = [];
  for (const w of windows) {
    out.push(...(await getLogsRaw({ ...params, ...w })));
  }
  return out;
}

export async function call(to: string, data: string): Promise<string> {
  return rpcCall<string>('eth_call', [{ to, data }, 'latest']);
}

// Largest number of eth_calls sent in one JSON-RPC batch.
export const MAX_BATCH = parseInt(process.env.BSC_MAX_BATCH ?? '100', 10);

export interface CallRequest {
  to: string;
  data: string;
}

export type ManyCaller = (requests: CallRequest[]) => Promise<(string | null)[]>;

// Many eth_calls in as few round-trips as possible, results in REQUEST ORDER.
//
// THIS IS WHAT MAKES THE BSC PORT VIABLE, and it has no counterpart in the Ethereum
// build, which issues every eth_call on its own. The reason is a difference of
// scale, not of taste: a 300-block Ethereum window holds ~40 pools, while the same
// window here holds 200–250, and BSC's long tail means most of them are new each
// cycle rather than cache hits. At a measured 192ms per sequential call, resolving
// one window's pools cost ~191s against a 120s poll interval — the indexer could
// not keep up with the chain at all. Batched, the same work is ~2s.
//
// A per-item error yields `null` for that item rather than throwing, so one bad
// address cannot discard a whole batch of good answers. Callers already treat a
// null/short result as "unresolved, do not cache", which is the correct reading.
export async function callMany(requests: CallRequest[]): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(requests.length).fill(null);
  for (let start = 0; start < requests.length; start += MAX_BATCH) {
    const slice = requests.slice(start, start + MAX_BATCH);
    const body = slice.map((r, i) => ({
      jsonrpc: '2.0',
      // The id is the index within this chunk, so a provider that reorders or
      // omits entries cannot silently shift every subsequent result onto the wrong
      // pool — which would mis-identify tokens rather than merely fail.
      id: i,
      method: 'eth_call',
      params: [{ to: r.to, data: r.data }, 'latest'],
    }));
    const results = await sendBatch(body);
    for (let i = 0; i < slice.length; i++) out[start + i] = results[i] ?? null;
  }
  return out;
}

async function sendBatch(
  body: unknown[],
  tries = 6
): Promise<Array<string | null>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BSC_RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (isRetryableHttp(res.status)) {
        if (attempt >= tries - 1) throw new RpcError(`eth_call batch: HTTP ${res.status}`);
        await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
      const json = (await res.json()) as
        | Array<{ id?: number; result?: string; error?: { message: string; code: number } }>
        | { error?: { message: string; code: number } };
      // A provider that rejects the whole batch answers with a single error object
      // instead of an array. Treated as retryable when it looks like throttling,
      // and otherwise surfaced — never mistaken for "every call returned nothing".
      if (!Array.isArray(json)) {
        const err = json.error;
        if (err && isRetryableRpcError(err.code, err.message) && attempt < tries - 1) {
          await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
          continue;
        }
        throw new RpcError(`eth_call batch: ${err?.message ?? 'non-array response'}`, err?.code);
      }
      const byId = new Map<number, string | null>();
      for (const entry of json) {
        if (typeof entry?.id !== 'number') continue;
        byId.set(entry.id, entry.error ? null : (entry.result ?? null));
      }
      return body.map((_, i) => byId.get(i) ?? null);
    } catch (err) {
      if (err instanceof RpcError || attempt >= tries - 1) throw err;
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
}

// Adapts a single-call function into a ManyCaller, for callers (and tests) that
// have one and not the other. Sequential, so it carries none of the speed-up —
// it exists for interface compatibility, not performance.
export function sequentialCallMany(
  one: (to: string, data: string) => Promise<string>
): ManyCaller {
  return async (requests) => {
    const out: (string | null)[] = [];
    for (const r of requests) {
      try {
        out.push(await one(r.to, r.data));
      } catch {
        out.push(null);
      }
    }
    return out;
  };
}
