// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { type Store, createStore } from '../stores/store';
import type { GableConfig, GableUser } from './schema';

/**
 * What the portal knows about its link to the ERP, as a store so the UI can
 * subscribe to it.
 *
 * Deliberately NOT persisted. Every other store in `stores/root.ts` survives a
 * reload; this one must not, because the thing it describes — a live session
 * against a server — does not. A restored `status: 'connected'` from yesterday
 * would render a green "Live" badge over a board full of stale local data,
 * which is precisely the lie this integration exists to stop telling.
 *
 * The session itself lives in an httpOnly cookie the browser owns. This store
 * holds only what the ERP told us about the signed-in user, and is re-derived
 * on every load by asking the ERP.
 */

export type GableConnectionStatus =
  /** No `GABLE_API_URL`. The simulator is the supplier and says so. */
  | 'standalone'
  /** Wired, but nobody is signed in (no cookie, or it expired). */
  | 'signed-out'
  /** A login or the initial catalog load is in flight. */
  | 'connecting'
  /** Signed in, catalog loaded from the ERP, order status read from the ERP. */
  | 'connected'
  /** Wired and reachable-in-principle, but the last call failed. */
  | 'error';

export interface GableState {
  status: GableConnectionStatus;
  user: GableUser | null;
  dealer: GableConfig | null;
  /** Contractor-readable reason for `error` / `signed-out`. Never a stack. */
  error: string | null;
  /** When order status was last read back from the ERP. */
  lastSyncAt: string | null;
  /** True while a status refresh is in flight, so the UI can show it working. */
  syncing: boolean;
  /** Count of ERP round trips this session — surfaced in the connection sheet. */
  requestCount: number;
}

export const INITIAL_GABLE_STATE: GableState = {
  status: 'standalone',
  user: null,
  dealer: null,
  error: null,
  lastSyncAt: null,
  syncing: false,
  requestCount: 0,
};

export const gableStore: Store<GableState> = createStore<GableState>(INITIAL_GABLE_STATE);

/** Narrow helper so call sites read as intent rather than as a string compare. */
export function isGableConnected(): boolean {
  return gableStore.get().status === 'connected';
}

export function setGableState(changes: Partial<GableState>): void {
  gableStore.set({ ...gableStore.get(), ...changes });
}

export function resetGableState(): void {
  gableStore.set(INITIAL_GABLE_STATE);
}
