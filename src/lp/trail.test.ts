import { describe, expect, it } from 'vitest';
import { POSITION_MANAGER, TOKENS } from './config';
import { TrailEntry, contractLabel, formatWhen, renderTrail, renderTrailEntry, statusIcon } from './trail';

const entry = (over: Partial<TrailEntry> = {}): TrailEntry => ({
  id: 'y7cscayqr8oczzjw7n467',
  status: 'success',
  startedAt: '2026-08-13T09:15:18.440Z',
  fn: 'burn',
  contract: POSITION_MANAGER,
  hash: '0x80a7d0cf63026141b3463696ac472e213cd93d6d5496bc68a89cb5d41f37b051',
  blockNumber: 25745135,
  gasUnits: '100065',
  sponsored: true,
  ...over,
});

describe('contractLabel', () => {
  it('names the position manager', () => {
    expect(contractLabel(POSITION_MANAGER)).toBe('position manager');
  });

  it('is case-insensitive, since the API echoes addresses lowercased', () => {
    expect(contractLabel(POSITION_MANAGER.toLowerCase())).toBe('position manager');
  });

  it('names a known token', () => {
    expect(contractLabel(TOKENS.WETH.address)).toBe('WETH');
  });

  // Guessing at an unknown contract would be worse than showing the address.
  it('falls back to a short address rather than inventing a name', () => {
    expect(contractLabel('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
  });

  it('tolerates a missing address', () => {
    expect(contractLabel(undefined)).toBe('');
  });
});

describe('statusIcon', () => {
  it('separates success, failure and in-flight', () => {
    expect(statusIcon('success')).toBe('✅');
    expect(statusIcon('error')).toBe('❌');
    expect(statusIcon('system_error')).toBe('❌');
    expect(statusIcon('running')).toBe('⏳');
  });

  // An unmapped status must not render as success.
  it('marks an unrecognised status as unknown', () => {
    expect(statusIcon('something_new')).toBe('❔');
    expect(statusIcon('something_new')).not.toBe('✅');
  });
});

describe('formatWhen', () => {
  // A trail is read alongside a block explorer, so the zone has to be fixed.
  it('renders UTC to the minute', () => {
    expect(formatWhen('2026-08-13T09:15:18.440Z')).toBe('2026-08-13 09:15');
  });

  it('degrades to a dash on missing or unparseable input', () => {
    expect(formatWhen(undefined)).toBe('—');
    expect(formatWhen('not a date')).toBe('—');
  });
});

describe('renderTrailEntry', () => {
  it('leads with what was called, not the hash', () => {
    const out = renderTrailEntry(entry());
    expect(out).toContain('<b>burn</b>');
    expect(out).toContain('position manager');
    expect(out).toContain('block 25,745,135');
    expect(out).toContain('100,065 gas');
    expect(out).toContain('sponsored');
    expect(out).toContain('etherscan.io/tx/0x80a7d0cf');
  });

  // The detail lookup can fail independently of the run existing; the row must
  // still testify that an execution happened.
  it('still renders a row whose detail lookup failed', () => {
    const out = renderTrailEntry(entry({ fn: undefined, contract: undefined, blockNumber: undefined, gasUnits: undefined, sponsored: undefined }));
    expect(out).toContain('call');
    expect(out).toContain('etherscan.io/tx/');
  });

  it('surfaces an error instead of hiding it behind the status icon', () => {
    const out = renderTrailEntry(entry({ status: 'error', error: 'execution reverted: STF' }));
    expect(out).toContain('❌');
    expect(out).toContain('STF');
  });

  it('says so when there is no transaction at all', () => {
    expect(renderTrailEntry(entry({ hash: undefined }))).toContain('no tx');
  });
});

describe('renderTrail', () => {
  it('says plainly when nothing has been signed', () => {
    expect(renderTrail([])).toBe('no executions recorded yet.');
  });

  it('heads the trail and names its source', () => {
    const out = renderTrail([entry(), entry({ fn: 'collect' })]);
    expect(out).toContain('audit trail');
    expect(out).toContain('last 2');
    expect(out).toContain('KeeperHub');
    expect(out).toContain('<b>burn</b>');
    expect(out).toContain('<b>collect</b>');
  });
});
