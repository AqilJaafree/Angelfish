import { logger } from '../logger';
import { CHAIN_ID, KEEPERHUB_API_KEY, KEEPERHUB_URL } from './config';

// KeeperHub client.
//
// KeeperHub exposes direct execution ONLY over its MCP endpoint — the public
// OpenAPI at /openapi.json documents just listed marketplace workflows
// (/api/mcp/workflows/<slug>/call), and there is no REST route for
// execute_contract_call. So this speaks MCP JSON-RPC over HTTP directly rather
// than going through a REST wrapper that does not exist.

interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

let sessionId: string | undefined;
let initialized = false;
let nextId = 1;

export function isConfigured(): boolean {
  return Boolean(KEEPERHUB_API_KEY);
}

// Reset so the next call re-handshakes. Called when the server rejects our
// session, which happens on token refresh and on server restart.
export function resetSession(): void {
  sessionId = undefined;
  initialized = false;
}

async function rpc(method: string, params?: unknown, isNotification = false): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // The server may answer either shape; both must be advertised or it 406s.
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    authorization: `Bearer ${KEEPERHUB_API_KEY}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!isNotification) body.id = nextId++;

  const res = await fetch(KEEPERHUB_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (res.status === 401 || res.status === 403) {
    resetSession();
    throw new Error(
      'KeeperHub rejected the API key (401). Check KEEPERHUB_API_KEY is a valid kh_… key.'
    );
  }
  // A notification has no response body to parse.
  if (isNotification) return {};

  const text = await res.text();
  if (!res.ok && !text) throw new Error(`KeeperHub HTTP ${res.status}`);

  // Streamable HTTP may answer as SSE; take the last `data:` frame, which
  // carries the JSON-RPC response.
  let payload = text;
  if (text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')) {
    const frames = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    payload = frames[frames.length - 1] ?? '';
  }
  if (!payload) throw new Error(`KeeperHub returned an empty body (HTTP ${res.status})`);
  return JSON.parse(payload) as JsonRpcResponse;
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'angelfish-lp-bot', version: '0.1.0' },
  });
  await rpc('notifications/initialized', undefined, true);
  initialized = true;
}

// Call a KeeperHub tool and return its parsed JSON payload. MCP wraps a tool's
// output in content[].text, so the real result is one JSON.parse deeper.
export async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!KEEPERHUB_API_KEY) throw new Error('KEEPERHUB_API_KEY is not set');
  await ensureInitialized();

  let res: JsonRpcResponse;
  try {
    res = await rpc('tools/call', { name, arguments: args });
  } catch (err) {
    // One retry after a fresh handshake covers an expired session, which is
    // otherwise indistinguishable from a hard failure.
    resetSession();
    await ensureInitialized();
    res = await rpc('tools/call', { name, arguments: args });
    logger.debug({ err }, 'keeperhub: retried after session reset');
  }

  if (res.error) throw new Error(`KeeperHub ${name}: ${res.error.message}`);
  const text = res.result?.content?.find((c) => c.type === 'text')?.text;
  if (text == null) throw new Error(`KeeperHub ${name}: no text content in result`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A tool error often arrives as a bare string rather than JSON.
    if (res.result?.isError) throw new Error(`KeeperHub ${name}: ${text}`);
    throw new Error(`KeeperHub ${name}: unparseable result: ${text.slice(0, 200)}`);
  }
  if (res.result?.isError) {
    throw new Error(`KeeperHub ${name}: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  return parsed as T;
}

export interface CallResult {
  // Scalar when the ABI output is unnamed (`totalSupply` -> "9184992…"), and an
  // object keyed by output name when it is named (`slot0` -> { sqrtPriceX96, tick, … }).
  // Both shapes come back under `result`, so callers must not assume a string.
  result?: unknown;
  success?: boolean;
  status?: string;
  wouldRevert?: boolean;
  revertReason?: string;
  gasEstimate?: string;
  transactionLink?: string;
  executionId?: string;
  error?: string;
}

// A view/pure call. Returns whatever shape `result` carries — see CallResult.
export async function read(
  contract: string,
  fn: string,
  args: unknown[] = [],
  abi?: string
): Promise<unknown> {
  const payload: Record<string, unknown> = {
    contract_address: contract,
    chain_id: CHAIN_ID,
    function_name: fn,
    function_args: JSON.stringify(args),
  };
  if (abi) payload.abi = abi;
  const out = await callTool<CallResult>('execute_contract_call', payload);
  return out.result;
}

// A read whose ABI outputs are named, returned as a field map.
export async function readFields(
  contract: string,
  fn: string,
  args: unknown[],
  abi: string
): Promise<Record<string, string>> {
  const raw = await read(contract, fn, args, abi);
  if (raw == null || typeof raw !== 'object') {
    throw new Error(`${fn}: expected named outputs, got ${JSON.stringify(raw)?.slice(0, 120)}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  return out;
}

// A read with a single unnamed output.
export async function readScalar(
  contract: string,
  fn: string,
  args: unknown[],
  abi: string
): Promise<string> {
  const raw = await read(contract, fn, args, abi);
  if (raw != null && typeof raw === 'object') {
    const vals = Object.values(raw as Record<string, unknown>);
    if (vals.length === 1) return String(vals[0]);
    throw new Error(`${fn}: expected one output, got ${vals.length}`);
  }
  return String(raw ?? '');
}

// A state-changing call. `simulate` MUST be a JSON boolean — KeeperHub rejects
// the string "true" — and a simulation is always run before the real send.
export async function write(
  contract: string,
  fn: string,
  args: unknown[],
  opts: { abi?: string; value?: string; simulate: boolean; idempotencyKey?: string }
): Promise<CallResult> {
  const payload: Record<string, unknown> = {
    contract_address: contract,
    chain_id: CHAIN_ID,
    function_name: fn,
    function_args: JSON.stringify(args),
    simulate: opts.simulate,
  };
  if (opts.abi) payload.abi = opts.abi;
  if (opts.value) payload.value = opts.value;
  // Only meaningful on a real send; on a simulate it would bind the key to a
  // body that never executes.
  if (!opts.simulate && opts.idempotencyKey) payload.idempotency_key = opts.idempotencyKey;
  return callTool<CallResult>('execute_contract_call', payload);
}
