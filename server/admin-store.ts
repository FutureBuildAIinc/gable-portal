// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type DealerConfig, parseConfig } from '../src/core/domain/config';

/**
 * The dealer's runtime configuration, on disk.
 *
 * Two stores, deliberately separate files:
 *
 * - `config.json` is PUBLIC. Every value in it is served to every visitor,
 *   because it is branding, terms, and feature flags. Nothing secret may ever
 *   be added to it.
 * - `secrets.json` is PRIVATE and never leaves this process. It holds the
 *   dealer's LLM credential. There is no code path that returns its contents
 *   to a browser — only `hasCredential` and a mask.
 *
 * Keeping them in different files rather than different keys of one object is
 * the point: a mistake that serialises "the config" cannot accidentally
 * serialise the secret, because the secret is not in that object.
 */

const DATA_DIR = join(process.cwd(), '.gablenow');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const SECRETS_FILE = join(DATA_DIR, 'secrets.json');
/**
 * Per-day request accounting, deliberately NOT in secrets.json.
 *
 * Counting used to read-modify-write the credential file on every assistant
 * request. `readSecrets` degrades to `{}` on any read failure — EMFILE under
 * load, EACCES, a torn file — and the very next line wrote that `{}` back,
 * silently destroying the dealer's key. A counter has no business sharing a
 * file with a secret.
 */
const USAGE_FILE = join(DATA_DIR, 'usage.json');

export interface StoredSecrets {
  anthropicKey?: string;
}

interface StoredUsage {
  day: string;
  /** Requests today, per contractor account. */
  accounts: Record<string, number>;
}

/**
 * Requests we could not attribute to an account.
 *
 * Kept as its own bucket rather than dropped: a dealer looking at the console
 * needs to see that something is spending their key even when it arrives
 * without an account, which is precisely the case worth noticing.
 */
const UNATTRIBUTED = 'unattributed';

/**
 * The account id arrives in a request header and becomes an object key written
 * to disk, so it is bounded here rather than trusted. Unknown shapes collapse
 * into UNATTRIBUTED instead of being rejected — losing the count of a
 * malformed caller would hide it, and hiding it is the failure mode that
 * matters.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizeAccountId(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.length > 64) return UNATTRIBUTED;
  // `__proto__` passes a plain charset check and then stops behaving like a
  // key: reads fall through to Object.prototype and the count silently
  // vanishes. Reject the three names that mean something to an object rather
  // than trusting the character class.
  if (UNSAFE_KEYS.has(trimmed)) return UNATTRIBUTED;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : UNATTRIBUTED;
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

/** Atomic write: a truncated config on a crash would reset a dealer's branding. */
function writeJson(file: string, value: unknown, mode: number): void {
  ensureDir();
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode });
  renameSync(temporary, file);
  try {
    chmodSync(file, mode);
  } catch {
    // Best effort — Windows and some mounts do not support it.
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The dealer's public config, defaults filled in. Re-validated on every read
 * because the file is hand-editable, and a bad value on disk must degrade to a
 * default rather than reaching the page.
 */
export function readConfig(): DealerConfig {
  const parsed = parseConfig(readJson(CONFIG_FILE) ?? {});
  if (parsed.ok) return parsed.value;
  console.error('[admin] stored config is invalid; serving defaults —', parsed.error);
  const fallback = parseConfig({});
  if (!fallback.ok) throw new Error('default config failed to parse');
  return fallback.value;
}

export function writeConfig(config: DealerConfig): void {
  writeJson(CONFIG_FILE, config, 0o600);
}

/**
 * A fingerprint of the config as it currently stands, for optimistic
 * concurrency.
 *
 * Hashes the PARSED config rather than the file bytes: two files that
 * normalise to the same settings are the same state, so reformatting the file
 * by hand must not look like somebody else's edit.
 */
export function configRevision(config: DealerConfig = readConfig()): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

// --- Secrets -----------------------------------------------------------------
//
// Everything below stays in this module and the admin API. Nothing here is
// reachable from a response body.

/**
 * Absent means "no key yet" and is safe. Present-but-unreadable is NOT — it
 * must never be mistaken for empty, or a caller that writes back what it read
 * would erase a key that was merely unreadable for a moment.
 */
function readSecrets(): StoredSecrets {
  if (!existsSync(SECRETS_FILE)) return {};
  const raw = readJson(SECRETS_FILE);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('secrets file is present but unreadable; refusing to treat it as empty');
  }
  return raw as StoredSecrets;
}

function writeSecrets(secrets: StoredSecrets): void {
  // 0600: readable only by the user running the server.
  writeJson(SECRETS_FILE, secrets, 0o600);
}

/** For the proxy only. Never call this from anything that builds a response. */
export function readStoredKey(): string | undefined {
  try {
    return readSecrets().anthropicKey;
  } catch (error) {
    // A momentarily unreadable file must not look like "no key configured",
    // but it also must not take the request path down.
    console.error('[admin] could not read the stored credential', error);
    return undefined;
  }
}

export function storeKey(key: string): void {
  // A fresh object rather than a spread of a possibly-unreadable file: storing
  // a key must work even when the previous contents cannot be parsed.
  writeSecrets({ anthropicKey: key });
}

export function clearStoredKey(): void {
  writeSecrets({});
}

/**
 * Enough to recognise which key is loaded, never enough to use. The admin UI
 * shows this; the raw value has no route out of the process.
 */
export function maskedKey(): string | null {
  const key = readStoredKey();
  if (!key) return null;
  return key.length <= 14 ? '••••••••' : `${key.slice(0, 11)}…${key.slice(-4)}`;
}

/**
 * Per-day request accounting for the dealer's cap.
 *
 * Counted here rather than in the proxy's in-memory rate limiter because a cap
 * a dealer sets to control their bill has to survive a dev-server restart.
 * Returns false when the request should be refused.
 */
function readUsage(): StoredUsage | null {
  const raw = readJson(USAGE_FILE);
  if (typeof raw !== 'object' || raw === null) return null;
  const usage = raw as Partial<StoredUsage> & { count?: unknown };
  if (typeof usage.day !== 'string') return null;

  if (usage.accounts && typeof usage.accounts === 'object') {
    const accounts: Record<string, number> = {};
    for (const [id, count] of Object.entries(usage.accounts)) {
      if (typeof count === 'number' && Number.isFinite(count))
        accounts[normalizeAccountId(id)] = count;
    }
    return { day: usage.day, accounts };
  }

  // A file written before usage was attributed. Keep the number rather than
  // discard the day's count; it simply belongs to nobody in particular.
  if (typeof usage.count === 'number') {
    return { day: usage.day, accounts: { [UNATTRIBUTED]: usage.count } };
  }
  return null;
}

/**
 * Returns false when the request should be refused.
 *
 * Fails OPEN on a storage error: a cap that cannot be persisted is a reason to
 * log, not a reason to take the assistant down for everyone. It touches only
 * the usage file, so a failure here can never reach the credential.
 */
/**
 * Which day a request counts against.
 *
 * The server's LOCAL day, not UTC. "Requests per day" is a promise made to a
 * dealer about their day, and a UTC boundary breaks it in every timezone west
 * of Greenwich: in Ontario the cap reset at 8pm and the console's usage figure
 * went back to zero while the yard was still open. A contractor capped at
 * lunchtime got a fresh allowance over dinner.
 *
 * `en-CA` is the shortest way to get YYYY-MM-DD out of toLocaleDateString.
 * A dealer in another timezone from their server is a real case, but it needs
 * a configured timezone rather than a different guess — and guessing UTC is
 * the one option that is wrong for almost everybody.
 */
export function usageDay(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA');
}

export function consumeDailyQuota(cap: number, today: string, accountId?: string): boolean {
  const account = normalizeAccountId(accountId);
  try {
    const stored = readUsage();
    const usage = stored?.day === today ? stored : { day: today, accounts: Object.create(null) };
    const used = usage.accounts[account] ?? 0;

    // Count first, enforce second. Returning early when no cap was set meant
    // the console reported "Used today: 0" forever on a default deployment —
    // which reads as "nobody used the assistant", not "nobody is counting".
    // That number is exactly how a dealer decides what the cap should be.
    //
    // The cap is PER ACCOUNT. "How much assistant does one contractor get" is
    // a different question from the dealer's total bill, and a single busy
    // crew must not be able to lock every other contractor out for the day.
    if (cap > 0 && used >= cap) return false;

    writeJson(
      USAGE_FILE,
      { day: today, accounts: { ...usage.accounts, [account]: used + 1 } },
      0o600,
    );
    return true;
  } catch (error) {
    console.error('[admin] daily usage could not be recorded; allowing the request', error);
    return true;
  }
}

export interface UsageToday {
  total: number;
  /** Busiest first — the dealer's question is "who is using this?" */
  byAccount: { accountId: string; count: number }[];
}

export function usageToday(today: string): UsageToday {
  try {
    const usage = readUsage();
    if (!usage || usage.day !== today) return { total: 0, byAccount: [] };
    const byAccount = Object.entries(usage.accounts)
      .map(([accountId, count]) => ({ accountId, count }))
      .sort((a, b) => b.count - a.count);
    return { total: byAccount.reduce((sum, row) => sum + row.count, 0), byAccount };
  } catch {
    return { total: 0, byAccount: [] };
  }
}

export const ADMIN_DATA_DIR = DATA_DIR;
export const ADMIN_CONFIG_PATH = CONFIG_FILE;
export { dirname };
