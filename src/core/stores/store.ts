// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
/**
 * The store primitive. Deliberately tiny and framework-free: React binds via
 * useSyncExternalStore (src/ui/hooks/useStore.ts), and a future Lit port binds
 * via a ReactiveController. Nothing here knows either exists.
 *
 * Snapshots are immutable — `set` must produce a new object, because
 * useSyncExternalStore uses reference identity to decide whether to re-render.
 */

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    get() {
      return state;
    },

    set(next) {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      // Copy before iterating: a listener may unsubscribe during notification.
      for (const listener of [...listeners]) listener();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Normalized collection shape used by every entity store. */
export interface Collection<T> {
  byId: Record<string, T>;
  allIds: string[];
}

export function emptyCollection<T>(): Collection<T> {
  return { byId: {}, allIds: [] };
}

export function collectionFrom<T extends { id: string }>(items: readonly T[]): Collection<T> {
  const byId: Record<string, T> = {};
  const allIds: string[] = [];
  for (const item of items) {
    byId[item.id] = item;
    allIds.push(item.id);
  }
  return { byId, allIds };
}

export function listOf<T>(collection: Collection<T>): T[] {
  const out: T[] = [];
  for (const id of collection.allIds) {
    const item = collection.byId[id];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function upsert<T extends { id: string }>(
  collection: Collection<T>,
  item: T,
): Collection<T> {
  const exists = collection.byId[item.id] !== undefined;
  return {
    byId: { ...collection.byId, [item.id]: item },
    allIds: exists ? collection.allIds : [...collection.allIds, item.id],
  };
}

export function patch<T extends { id: string }>(
  collection: Collection<T>,
  id: string,
  changes: Partial<T>,
): Collection<T> {
  const existing = collection.byId[id];
  if (existing === undefined) return collection;
  return {
    byId: { ...collection.byId, [id]: { ...existing, ...changes } },
    allIds: collection.allIds,
  };
}

export function remove<T>(collection: Collection<T>, id: string): Collection<T> {
  if (collection.byId[id] === undefined) return collection;
  const byId = { ...collection.byId };
  delete byId[id];
  return { byId, allIds: collection.allIds.filter((existing) => existing !== id) };
}
