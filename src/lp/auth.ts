import { OWNER_ID, OWNER_USERNAME } from './config';

export interface Sender {
  id: number;
  username?: string;
  isPrivateChat: boolean;
}

export interface OwnerConfig {
  ownerId: number;
  ownerUsername: string;
}

export type AuthVerdict =
  | { ok: true }
  | { ok: false; reason: 'not-owner' | 'not-private'; detail: string };

// Read at call time, not module load, so the deployment's .env decides and the
// owner's identity never has to appear in a tracked file.
const configuredOwner = (): OwnerConfig => ({ ownerId: OWNER_ID, ownerUsername: OWNER_USERNAME });

// The whole authorisation surface of the bot, in one pure function so it can be
// tested exhaustively without a network and without naming a real account.
//
// Two independent gates, and BOTH must pass:
//
//  1. The numeric Telegram user id must equal the configured owner id. Telegram
//     user ids are permanent and non-transferable; usernames are neither.
//     Matching on `from.username` would mean that if the username were ever
//     changed or released, whoever registered it next could drain the wallet —
//     so the username is compared only to raise a warning, never to grant access.
//
//  2. The chat must be a private DM. Without this the bot would accept commands
//     from any group it is added to, where a message can be forwarded or posted
//     by a bot impersonating the owner's display name.
//
// Fails closed: the owner id has no default, so an unconfigured bot (0) matches
// no real Telegram account and refuses everyone.
export function authorize(sender: Sender, owner: OwnerConfig = configuredOwner()): AuthVerdict {
  if (!sender.isPrivateChat) {
    return {
      ok: false,
      reason: 'not-private',
      detail: 'LP commands are accepted in a direct message only.',
    };
  }
  if (!owner.ownerId || sender.id !== owner.ownerId) {
    return {
      ok: false,
      reason: 'not-owner',
      detail: 'Not authorised.',
    };
  }
  return { ok: true };
}

// A username that no longer matches the configured id is worth surfacing: it is
// either a harmless rename by the owner, or evidence the pinned id is stale.
// Either way the id keeps deciding access — this only decides whether we log.
export function usernameMismatch(sender: Sender, owner: OwnerConfig = configuredOwner()): boolean {
  if (!owner.ownerId || sender.id !== owner.ownerId) return false;
  if (!owner.ownerUsername) return false; // no expected username configured
  if (!sender.username) return true;
  return sender.username.toLowerCase() !== owner.ownerUsername.toLowerCase();
}
