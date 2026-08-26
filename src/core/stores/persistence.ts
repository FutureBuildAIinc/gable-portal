// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Store } from './store';

/**
 * localStorage persistence with versioned migrations, cross-tab adoption, and
 * single-writer scheduling.
 *
 * Chosen over IndexedDB deliberately: the whole demo state is a few hundred KB,
 * a synchronous read at boot means no hydration flash, and it is inspectable in
 * DevTools. Cross-tab is NOT free, though, and pretending it was cost us: two
 * open tabs each ran their own simulator over the same persisted queue and
 * clobbered each other's writes per key — including a signed QuoteAcceptance.
 * So two mechanisms exist explicitly:
 *
 * - `attachCrossTabSync` listens for `storage` events and adopts the other
 *   tab's write into the local store. This is what makes "customer accepts in
 *   another window and the contractor's board updates live" actually true.
 *   Echoes cannot loop: the browser never fires `storage` in the writing tab,
 *   and re-writing an identical string fires no event elsewhere.
 * - A leadership lease (`gn:leader`, heartbeat-renewed) ensures exactly one
 *   tab pumps the simulator. Everyone else adopts the leader's writes.
 *
 * The migration path matters for a demo tool specifically: schema changes are
 * frequent during development, and the failure mode of a half-read old state is
 * a broken app in front of an audience. So an unreadable, invalid, or
 * future-versioned payload wipes and reseeds rather than limping along.
 */

const KEY_PREFIX = 'gn:';
let quotaWarned = false;
const META_KEY = `${KEY_PREFIX}meta`;

/**
 * Bump when the seeded scenario gains data an existing demo would otherwise
 * never see. M5->M6/M7 added open AR (the Kirkland invoice and a counter sale);
 * v3 added the seeded team (roles demo) — a browser holding older state would
 * restore straight past the seed and show an empty Team screen.
 */
export const SCHEMA_VERSION = 3;

export interface PersistMeta {
  schemaVersion: number;
  seed: number;
  savedAt: string;
}

type RawState = Record<string, unknown>;

/**
 * Keyed by TARGET version: MIGRATIONS[2] upgrades a v1 payload to v2. Run in
 * ascending order, so a v1 payload can climb to the current version in steps.
 *
 * A missing step is a deliberate signal, not a gap to skip over: it means the
 * bump was a reseed (new demo data an old save must not restore past — that is
 * what v2 was), so migrate() returns null and the caller wipes. Only add an
 * entry here when old state can genuinely be carried forward.
 */
const MIGRATIONS: Record<number, (raw: RawState) => RawState> = {
  // v2 was the AR/sales-order seed bump — a reseed by design, so no entry.
};

export interface PersistedStore<T> {
  key: string;
  store: Store<T>;
}

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function readMeta(): PersistMeta | null {
  if (!storageAvailable()) return null;
  const raw = localStorage.getItem(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistMeta;
  } catch {
    return null;
  }
}

export function writeMeta(meta: PersistMeta): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch (error) {
    // Quota or private-mode failure. The demo keeps running from memory; a
    // throw here would abort boot or the pagehide flush mid-write.
    console.error('[persistence] failed to write meta', error);
  }
}

/**
 * Applies migrations from the stored version up to SCHEMA_VERSION.
 * Returns null when the payload cannot be salvaged — caller should reseed.
 */
export function migrate(raw: RawState, fromVersion: number): RawState | null {
  if (fromVersion > SCHEMA_VERSION) return null; // came from a newer build
  let state = raw;
  for (let version = fromVersion + 1; version <= SCHEMA_VERSION; version++) {
    const migration = MIGRATIONS[version];
    if (!migration) return null; // an uncovered step means "reseed", not "skip"
    try {
      state = migration(state);
    } catch {
      return null;
    }
  }
  return state;
}

export function loadStoreState<T>(key: string): T | null {
  if (!storageAvailable()) return null;
  const raw = localStorage.getItem(KEY_PREFIX + key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveStoreState<T>(key: string, value: T): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
  } catch (error) {
    // Quota or private-mode failure: the demo keeps running from memory —
    // but say so once, or a field failure is undiagnosable.
    if (!quotaWarned) {
      quotaWarned = true;
      console.error(
        `[persistence] failed to write "${key}" — state is no longer being saved`,
        error,
      );
    }
  }
}

export function clearPersistedState(): void {
  if (!storageAvailable()) return;
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(KEY_PREFIX)) doomed.push(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
}

/**
 * Writes a store's snapshot on change, debounced so a burst of edits (dragging
 * a qty stepper) doesn't hammer localStorage.
 */
export function attachPersistence<T>(key: string, store: Store<T>, debounceMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    saveStoreState(key, store.get());
    writeMeta({
      schemaVersion: SCHEMA_VERSION,
      seed: readMeta()?.seed ?? 0,
      savedAt: new Date().toISOString(),
    });
  };

  pendingFlushes.add(flush);

  const unsubscribe = store.subscribe(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    pendingFlushes.delete(flush);
    unsubscribe();
  };
}

/**
 * Writes every attached store immediately, bypassing the debounce.
 *
 * Matters because the debounce means the last action before a reload might not
 * have landed — a contractor who moves a card and instantly closes the tab
 * should not lose it. Call on pagehide, and in tests that assert persistence.
 */
const pendingFlushes = new Set<() => void>();

export function flushPersistence(): void {
  for (const flush of pendingFlushes) flush();
}

/**
 * Structural validation for a restored payload. localStorage is user-writable
 * and survives deploys, so nothing read from it is trusted until its shape
 * matches what the code dereferences — a field rename shipped without a schema
 * bump used to restore "successfully" and then crash the first selector.
 */
export function isValidCollection(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const collection = value as { byId?: unknown; allIds?: unknown };
  if (typeof collection.byId !== 'object' || collection.byId === null) return false;
  if (!Array.isArray(collection.allIds)) return false;
  return collection.allIds.every(
    (id) =>
      typeof id === 'string' &&
      typeof (collection.byId as Record<string, unknown>)[id] === 'object' &&
      (collection.byId as Record<string, unknown>)[id] !== null,
  );
}

export function isValidActivity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const activity = value as { entries?: unknown; readWatermark?: unknown };
  return Array.isArray(activity.entries) && typeof activity.readWatermark === 'string';
}

export function isValidSim(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const sim = value as {
    tasks?: unknown;
    anchorSim?: unknown;
    anchorReal?: unknown;
    speed?: unknown;
  };
  return (
    Array.isArray(sim.tasks) &&
    typeof sim.anchorSim === 'number' &&
    typeof sim.anchorReal === 'number' &&
    typeof sim.speed === 'number' &&
    sim.speed > 0
  );
}

export function isValidTeam(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const team = value as { members?: unknown; activeId?: unknown };
  return (
    isValidCollection(team.members) && (team.activeId === null || typeof team.activeId === 'string')
  );
}

export function validateStoreState(key: string, value: unknown): boolean {
  if (key === 'activity') return isValidActivity(value);
  if (key === 'sim') return isValidSim(value);
  if (key === 'team') return isValidTeam(value);
  return isValidCollection(value);
}

/**
 * Preserve a corrupt payload before wiping it. Reseeding is the right recovery
 * for a demo, but silently destroying the evidence would make the corruption
 * undiagnosable — and if it was real user state, unrecoverable.
 */
export function stashCorruptState(reason: string): void {
  if (!storageAvailable()) return;
  try {
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) snapshot[key] = localStorage.getItem(key) ?? '';
    }
    localStorage.setItem(
      `${KEY_PREFIX}corrupt-backup`,
      JSON.stringify({ reason, at: new Date().toISOString(), snapshot }),
    );
  } catch {
    // Best effort only.
  }
}

/**
 * Adopts writes made by OTHER tabs into this tab's stores. The `storage` event
 * fires only in tabs that did not perform the write, so there is no echo; and
 * because the local store is set to exactly what localStorage now holds, the
 * debounced flush that follows rewrites an identical string and fires no
 * further events. Invalid payloads are ignored rather than adopted.
 */
export function attachCrossTabSync(
  entries: readonly PersistedStore<unknown>[],
  onAdopted?: (key: string) => void,
): () => void {
  if (typeof window === 'undefined' || !storageAvailable()) return () => {};

  const byStorageKey = new Map(entries.map((entry) => [KEY_PREFIX + entry.key, entry]));

  const listener = (event: StorageEvent) => {
    if (!event.key || event.newValue === null) return;
    const entry = byStorageKey.get(event.key);
    if (!entry) return;
    try {
      const value = JSON.parse(event.newValue);
      if (!validateStoreState(entry.key, value)) return;
      entry.store.set(value);
      onAdopted?.(entry.key);
    } catch {
      // A torn or foreign write; the next valid one will land.
    }
  };

  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

// --- Scheduler leadership ----------------------------------------------------
//
// Exactly one tab may pump the simulator. The lease lives in localStorage and
// is renewed by heartbeat; a tab that closes without releasing (crash, kill)
// goes stale within LEASE_TTL_MS and the next tab takes over.

const LEADER_KEY = `${KEY_PREFIX}leader`;
export const LEASE_TTL_MS = 7_000;

interface LeaderLease {
  tabId: string;
  ts: number;
}

function readLease(): LeaderLease | null {
  if (!storageAvailable()) return null;
  const raw = localStorage.getItem(LEADER_KEY);
  if (!raw) return null;
  try {
    const lease = JSON.parse(raw) as LeaderLease;
    return typeof lease.tabId === 'string' && typeof lease.ts === 'number' ? lease : null;
  } catch {
    return null;
  }
}

/** True when the lease is absent, expired, or already this tab's. */
function leaseIsAvailableTo(tabId: string): boolean {
  const lease = readLease();
  if (lease === null) return true;
  if (lease.tabId === tabId) return true;
  return Date.now() - lease.ts >= LEASE_TTL_MS;
}

/** True when this tab now holds (or already held) the lease. */
export function tryAcquireLeadership(tabId: string): boolean {
  if (!storageAvailable()) return true; // no storage, no second tab to race
  if (!leaseIsAvailableTo(tabId)) return false;
  try {
    localStorage.setItem(LEADER_KEY, JSON.stringify({ tabId, ts: Date.now() }));
  } catch {
    return true; // storage broken: behave as a lone tab
  }
  // Re-read rather than assume. localStorage has no compare-and-set, so two
  // tabs booting in the same instant can both see a free lease; whoever wrote
  // last is the one the lease actually names, and the other must stand down.
  return readLease()?.tabId === tabId;
}

/**
 * Renew this tab's lease. Returns false when the lease is no longer ours, and
 * does NOT take it back.
 *
 * That refusal is the whole point. The heartbeat renews every 2.5s against a
 * 7s TTL, which is ample — until the browser throttles a BACKGROUND tab's
 * timers to roughly once a minute. The lease then lapses, a foreground tab
 * correctly takes over, and the sleeping tab's throttled interval finally
 * fires. An unconditional write at that moment stole the lease straight back
 * while the new leader carried on believing it held it, so BOTH tabs pumped the
 * simulator over one persisted queue — the exact "every piece of supplier work
 * fired twice" failure the lease was introduced to stop, reached by the most
 * ordinary user action there is: leaving a tab open in the background.
 */
export function renewLeadership(tabId: string): boolean {
  if (!storageAvailable()) return true;
  if (!leaseIsAvailableTo(tabId)) return false;
  try {
    localStorage.setItem(LEADER_KEY, JSON.stringify({ tabId, ts: Date.now() }));
  } catch {
    // Ignore; staleness will be judged from the last successful renewal.
    return true;
  }
  return readLease()?.tabId === tabId;
}

export function releaseLeadership(tabId: string): void {
  if (!storageAvailable()) return;
  if (readLease()?.tabId !== tabId) return;
  localStorage.removeItem(LEADER_KEY);
}
