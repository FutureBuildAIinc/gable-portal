// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moveOrderToStage, systemInvoiceOrder } from '../actions/orders';
import { boot, getContext } from '../boot';
import { canMoveToStage } from '../domain/stage';
import { buildBoardCards, buildProjectSummaries, groupByStage } from '../selectors/board';
import { flushPersistence } from '../stores/persistence';
import { ordersStore, projectsStore, scopeStore } from '../stores/root';
import { listOf } from '../stores/store';

/**
 * Tests run in `environment: 'node'` because core is DOM-free — but persistence
 * genuinely targets localStorage, so it gets a minimal shim rather than being
 * left untested.
 */
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

/**
 * End-to-end over the real path the board uses: boot -> seeded scenario ->
 * selectors -> actions -> stage machine. This is what the drag actually does,
 * minus dnd-kit's pointer handling.
 */

function cards() {
  return buildBoardCards(ordersStore.get(), projectsStore.get(), scopeStore.get());
}

function cardFor(orderId: string) {
  const found = cards().find((card) => card.order.id === orderId);
  if (!found) throw new Error(`no card for ${orderId}`);
  return found;
}

function itemsFor(orderId: string) {
  return listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
}

describe('board flow', () => {
  beforeEach(() => {
    boot({ reset: true, seed: 20_260_730 });
  });

  it('seeds orders across every stage', () => {
    const columns = groupByStage(cards());
    const counts = Object.fromEntries(columns.map((c) => [c.stage, c.cards.length]));

    expect(counts.plan).toBeGreaterThan(0);
    expect(counts.quote).toBeGreaterThan(0);
    expect(counts.order).toBeGreaterThan(0);
    expect(counts.invoice).toBeGreaterThan(0);
  });

  it('prices seeded scope through the ERP engine, not hand-written numbers', () => {
    const card = cardFor('ord_miller_frame');
    expect(card.totals.subtotal).toBeGreaterThan(0);
    // Account pricing must beat list, or the whole value proposition is invisible.
    expect(card.totals.savings).toBeGreaterThan(0);
    expect(card.totals.listSubtotal).toBeGreaterThan(card.totals.subtotal);
  });

  it('lets a fully priced order go straight to Order, skipping the quote desk', () => {
    const result = moveOrderToStage('ord_miller_frame', 'order');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.order.stage).toBe('order');
      expect(result.value.effects).toEqual([{ kind: 'create-sales-order' }]);
    }
  });

  it('blocks the order that carries an unpriced special-order line, and says why', () => {
    const card = cardFor('ord_miller_deck');
    const decision = canMoveToStage(card.order, 'order', {
      items: itemsFor(card.order.id),
      now: getContext().clock.nowIso(),
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error).toContain('Trex Transcend rail kit');
      expect(decision.error).toContain('quote desk');
    }

    // And the action refuses too — the guard is not merely advisory.
    expect(moveOrderToStage(card.order.id, 'order').ok).toBe(false);
    expect(cardFor(card.order.id).order.stage).toBe('plan');
  });

  it('offers only the quote desk as a forward target for that order', () => {
    expect(cardFor('ord_miller_deck').allowedTargets).toEqual(['quote']);
  });

  it('refuses to move the empty draft anywhere forward', () => {
    const card = cardFor('ord_miller_pergola');
    expect(card.totals.itemCount).toBe(0);
    expect(card.allowedTargets).toEqual([]);

    const result = moveOrderToStage(card.order.id, 'quote');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('empty');
  });

  it('never lets a contractor drag a card into Invoice', () => {
    const result = moveOrderToStage('ord_wilson_frame', 'invoice');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('supplier');
  });

  it('lets the supplier invoice a delivered order', () => {
    expect(systemInvoiceOrder('ord_wilson_frame').ok).toBe(true);
    expect(cardFor('ord_wilson_frame').order.stage).toBe('invoice');
  });

  it('keeps one project spread across several stages at once', () => {
    // The reason board cards are orders and not projects.
    const wilson = buildProjectSummaries(cards()).find((s) => s.project.id === 'prj_wilson');
    expect(wilson?.stages).toEqual(['plan', 'order']);
    expect(wilson?.cards).toHaveLength(3);
  });

  it('flags a lead time that cannot make the requested date', () => {
    // The concrete on Miller framing is out of stock and weeks out, against a
    // delivery date nine days away.
    const card = cardFor('ord_miller_frame');
    const daysOut = 9;
    expect(card.maxLeadTimeDays).toBeGreaterThan(daysOut);
  });

  it('persists a move across a reboot', () => {
    moveOrderToStage('ord_miller_frame', 'quote');
    // Writes are debounced; a reload right after an action must not lose it.
    flushPersistence();

    boot({ seed: 20_260_730 });
    expect(cardFor('ord_miller_frame').order.stage).toBe('quote');
  });

  it('does not stack persistence subscribers across reboots', () => {
    // Demo Reset re-boots; each one must dispose the previous subscriptions or
    // every reset would add another writer to the same key.
    for (let i = 0; i < 3; i++) boot({ seed: 20_260_730 });

    moveOrderToStage('ord_miller_frame', 'quote');
    flushPersistence();
    boot({ seed: 20_260_730 });

    expect(cardFor('ord_miller_frame').order.stage).toBe('quote');
  });

  it('column totals equal the sum of their cards', () => {
    for (const column of groupByStage(cards())) {
      const sum = column.cards.reduce((total, card) => total + card.totals.subtotal, 0);
      expect(column.total).toBe(sum);
    }
  });
});
