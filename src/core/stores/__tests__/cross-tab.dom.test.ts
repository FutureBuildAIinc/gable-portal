// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeEach, describe, expect, it } from 'vitest';
import { activeMember, switchActiveMember } from '../../actions/team';
import { boot } from '../../boot';
import { customerQuotesStore, teamStore } from '../root';

/**
 * Cross-tab adoption, in a real DOM.
 *
 * This needs `window` for the storage event, so it lives in the jsdom project
 * — the node project stays DOM-free, which is what keeps `src/core` honest
 * about the Lit migration it is aimed at.
 */

const MARCUS = 'tm_marcus';
const ROBIN = 'tm_robin';

function otherTabWrites(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  localStorage.setItem(`gn:${key}`, raw);
  // Browsers never fire `storage` in the writing tab, so this is exactly what
  // a real second window produces here.
  window.dispatchEvent(new StorageEvent('storage', { key: `gn:${key}`, newValue: raw }));
}

beforeEach(() => {
  localStorage.clear();
  boot({ reset: true, seed: 20_260_730 });
});

describe('what follows another window', () => {
  it('adopts supplier and quote state, which is the point of the feature', () => {
    const quotes = customerQuotesStore.get();
    otherTabWrites('customerQuotes', {
      byId: { cq_x: { id: 'cq_x', orderId: 'ord_miller_deck', status: 'accepted' } },
      allIds: ['cq_x'],
    });

    expect(customerQuotesStore.get()).not.toBe(quotes);
    expect(customerQuotesStore.get().allIds).toContain('cq_x');
  });

  /**
   * `activeId` is who YOU are in THIS window. Adopting it meant a contractor's
   * tab silently became A/P because someone switched people elsewhere — which
   * then changes what every button in this window will let them do.
   */
  it('does not adopt another window’s active person', () => {
    switchActiveMember(MARCUS);
    expect(activeMember()?.id).toBe(MARCUS);

    otherTabWrites('team', { members: teamStore.get().members, activeId: ROBIN });

    expect(activeMember()?.id).toBe(MARCUS);
  });
});
