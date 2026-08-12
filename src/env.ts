import fs from 'fs';
import path from 'path';

// Minimal .env loader, imported FIRST by src/index.ts.
//
// Import order matters and is load-bearing: every module under src/mainnet reads
// process.env at module scope (config.ts is all top-level `parseInt(process.env…)`),
// and those reads happen when the module is first required. Under the CommonJS
// target the compiler emits `require` calls in source order, so this file is only
// effective while it stays the first import in index.ts. Moving it below any
// mainnet import silently reverts every setting to its default.
//
// Existing environment variables always win, so an inline `FOO=bar npm start`
// overrides the file rather than the other way round.
export function loadEnv(file = path.join(process.cwd(), '.env')): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env is a normal, silent case
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    // Strip one layer of matching quotes, as every dotenv implementation does.
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    process.env[key] = value;
  }
}

loadEnv();
