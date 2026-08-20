// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCustomerQuote, sendCustomerQuote } from '../actions/customer-quote';
import { boot } from '../boot';
import { saveStoreState } from '../stores/persistence';
import { PERSISTED_STORES, customerQuotesStore } from '../stores/root';
import { listOf } from '../stores/store';

/**
 * The first save must be COMPLETE.
 *
 * `attachPersistence` writes on CHANGE, which never happens to the seeded
 * stores — so a fresh demo left `projects`, `orders`, and `scope` absent from
 * localStorage while `customerQuotes` and `activity` were written the moment
 * the contractor did anything. A second tab then loaded a save carrying a
 * customer quote but no core trio, failed the trio check in `restorePersisted`,
 * reseeded from scratch (which has no customer quotes), and the share link
 * opened on "This link is no longer valid" — the two-window accept demo, broken
 * on every fresh install.
 *
 * It self-healed on any reload of the contractor tab, which is why it survived
 * so long unnoticed.
 *
 * NOTHING HERE MAY CALL `flushPersistence()`. It writes EVERY attached store
 * unconditionally, so calling it manufactures exactly the complete save this
 * file exists to prove we write on our own — the first version of these tests
 * passed with the bug reintroduced for precisely that reason. The browser only
 * flushes on `pagehide`; during a live session a store reaches disk only when
 * it CHANGES, which is the whole point.
 */

const SEED = 20_260_730;

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

describe('the very first boot', () => {
  it('writes every persisted store, not just the ones that later change', () => {
    boot({ reset: true, seed: SEED });

    const missing = PERSISTED_STORES.map((entry) => entry.key).filter(
      (key) => localStorage.getItem(`gn:${key}`) === null,
    );

    expect(missing, 'a second tab reads these — an absent one reseeds the demo').toEqual([]);
  });

  it('leaves a sent customer quote reachable by token from a second tab', () => {
    boot({ reset: true, seed: SEED });

    const built = buildCustomerQuote('ord_miller_frame');
    expect(built.ok, built.ok ? '' : built.error).toBe(true);
    const sent = sendCustomerQuote(built.ok ? built.value.id : '');
    expect(sent.ok, sent.ok ? '' : sent.error).toBe(true);
    const token = sent.ok ? sent.value.shareToken : '';
    expect(token).toBeTruthy();

    // Exactly what a live session does: the debounce writes ONLY the store
    // that changed. Everything else is on disk because boot put it there.
    saveStoreState('customerQuotes', customerQuotesStore.get());

    // A second tab: same storage, fresh boot, no reset.
    boot({ seed: SEED });

    const found = listOf(customerQuotesStore.get()).find((q) => q.shareToken === token);
    expect(found, 'the share link must still resolve in another window').toBeDefined();
    expect(found?.status).toBe('sent');
  });
});
