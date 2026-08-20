// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Store } from '@core/stores/store';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';

/**
 * The ONLY module that knows about both the core stores and React.
 *
 * That is the whole point of the architecture: when this app migrates to Lit,
 * this file is replaced by a ~15-line ReactiveController and every file under
 * src/core moves untouched. If you find yourself importing React anywhere in
 * src/core, the design has drifted.
 */
export function useStore<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  return useSyncExternalStoreWithSelector(
    store.subscribe,
    store.get,
    store.get, // no SSR — the server snapshot is the client snapshot
    selector,
    isEqual,
  );
}

/** Shallow array equality — for selectors returning derived lists. */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
