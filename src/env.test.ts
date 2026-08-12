import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnv } from './env';

const written: string[] = [];

function envFile(contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'angelfish-')), '.env');
  fs.writeFileSync(file, contents);
  written.push(file);
  return file;
}

afterEach(() => {
  for (const f of written.splice(0)) fs.rmSync(path.dirname(f), { recursive: true, force: true });
  delete process.env.ANGELFISH_TEST_A;
  delete process.env.ANGELFISH_TEST_B;
});

describe('loadEnv', () => {
  it('loads keys, skipping comments and blanks', () => {
    loadEnv(envFile('# a comment\n\nANGELFISH_TEST_A=hello\n'));
    expect(process.env.ANGELFISH_TEST_A).toBe('hello');
  });

  it('never overrides a variable already in the environment', () => {
    process.env.ANGELFISH_TEST_A = 'from-shell';
    loadEnv(envFile('ANGELFISH_TEST_A=from-file'));
    expect(process.env.ANGELFISH_TEST_A).toBe('from-shell');
  });

  it('strips one layer of matching quotes', () => {
    loadEnv(envFile('ANGELFISH_TEST_A="quoted"\nANGELFISH_TEST_B=\'single\''));
    expect(process.env.ANGELFISH_TEST_A).toBe('quoted');
    expect(process.env.ANGELFISH_TEST_B).toBe('single');
  });

  it('keeps = signs inside a value (RPC URLs carry API keys as query params)', () => {
    loadEnv(envFile('ANGELFISH_TEST_A=https://rpc.example/v2?key=abc=def'));
    expect(process.env.ANGELFISH_TEST_A).toBe('https://rpc.example/v2?key=abc=def');
  });

  it('is a no-op when the file does not exist', () => {
    expect(() => loadEnv('/nonexistent/.env')).not.toThrow();
  });
});
