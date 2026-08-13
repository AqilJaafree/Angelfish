import { describe, expect, it } from 'vitest';
import { authorize, usernameMismatch } from './auth';

// Synthetic throughout. The real owner id and username live only in the
// gitignored .env, so no tracked file — this one included — names the account.
const OWNER = { ownerId: 4242, ownerUsername: 'owner_handle' };
const dm = (id: number, username?: string) => ({ id, username, isPrivateChat: true });

describe('authorize', () => {
  it('admits the configured owner id in a DM', () => {
    expect(authorize(dm(OWNER.ownerId, OWNER.ownerUsername), OWNER).ok).toBe(true);
  });

  // The central security property: the username is NOT a credential. Whoever
  // acquires the handle after it is released must still be refused.
  it('refuses the right username from the wrong id', () => {
    const v = authorize(dm(999, OWNER.ownerUsername), OWNER);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('not-owner');
  });

  it('admits the owner id even with no username at all', () => {
    expect(authorize(dm(OWNER.ownerId, undefined), OWNER).ok).toBe(true);
  });

  // A group message is refused even from the owner: group senders can be
  // impersonated by display name, and the bot signs transactions.
  it('refuses the owner outside a DM', () => {
    const v = authorize({ id: OWNER.ownerId, username: OWNER.ownerUsername, isPrivateChat: false }, OWNER);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('not-private');
  });

  it('refuses a stranger outside a DM', () => {
    expect(authorize({ id: 12345, isPrivateChat: false }, OWNER).ok).toBe(false);
  });

  // An unconfigured deployment must refuse everyone rather than fall open.
  it('refuses everyone when no owner id is configured', () => {
    const unset = { ownerId: 0, ownerUsername: '' };
    expect(authorize(dm(0), unset).ok).toBe(false);
    expect(authorize(dm(4242), unset).ok).toBe(false);
    expect(authorize(dm(NaN), unset).ok).toBe(false);
  });

  // Both rejections must read identically, so a reply cannot be used to probe
  // who the owner is.
  it('does not leak the owner id in the rejection text', () => {
    const v = authorize(dm(999, 'someone'), OWNER);
    expect(v.ok === false && v.detail).not.toContain(String(OWNER.ownerId));
    expect(v.ok === false && v.detail).toBe('Not authorised.');
  });
});

describe('usernameMismatch', () => {
  it('is false for the expected username, case-insensitively', () => {
    expect(usernameMismatch(dm(OWNER.ownerId, 'OWNER_HANDLE'), OWNER)).toBe(false);
  });
  it('is true when the owner id carries an unexpected username', () => {
    expect(usernameMismatch(dm(OWNER.ownerId, 'someone-else'), OWNER)).toBe(true);
  });
  it('is true when the owner id carries no username', () => {
    expect(usernameMismatch(dm(OWNER.ownerId, undefined), OWNER)).toBe(true);
  });
  it('ignores non-owners entirely', () => {
    expect(usernameMismatch(dm(999, 'whatever'), OWNER)).toBe(false);
  });
  it('stays quiet when no expected username is configured', () => {
    const noName = { ownerId: 4242, ownerUsername: '' };
    expect(usernameMismatch(dm(4242, 'anything'), noName)).toBe(false);
    expect(usernameMismatch(dm(4242, undefined), noName)).toBe(false);
  });
});
