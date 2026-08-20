// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it, vi } from 'vitest';
import { collectionFrom, createStore, listOf, patch, remove, upsert } from '../store';

describe('createStore', () => {
  it('notifies subscribers on change', () => {
    const store = createStore({ n: 0 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ n: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ n: 1 });
  });

  it('skips notification when the snapshot is identical', () => {
    const initial = { n: 0 };
    const store = createStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(initial);
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports updater functions', () => {
    const store = createStore({ n: 1 });
    store.set((prev) => ({ n: prev.n + 1 }));
    expect(store.get().n).toBe(2);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ n: 0 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.set({ n: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('tolerates a listener unsubscribing during notification', () => {
    const store = createStore({ n: 0 });
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(() => unsubscribeFirst());
    store.subscribe(second);

    expect(() => store.set({ n: 1 })).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('collections', () => {
  const seed = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Bravo' },
  ];

  it('preserves insertion order', () => {
    const collection = collectionFrom(seed);
    expect(listOf(collection).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('appends on insert and keeps position on update', () => {
    let collection = collectionFrom(seed);
    collection = upsert(collection, { id: 'c', label: 'Charlie' });
    expect(collection.allIds).toEqual(['a', 'b', 'c']);

    collection = upsert(collection, { id: 'a', label: 'Updated' });
    expect(collection.allIds).toEqual(['a', 'b', 'c']);
    expect(collection.byId.a?.label).toBe('Updated');
  });

  it('patches without touching order and ignores unknown ids', () => {
    const collection = collectionFrom(seed);
    const patched = patch(collection, 'b', { label: 'Changed' });
    expect(patched.byId.b?.label).toBe('Changed');
    expect(patched.allIds).toEqual(['a', 'b']);

    expect(patch(collection, 'missing', { label: 'x' })).toBe(collection);
  });

  it('removes by id', () => {
    const collection = remove(collectionFrom(seed), 'a');
    expect(collection.allIds).toEqual(['b']);
    expect(collection.byId.a).toBeUndefined();
  });
});
