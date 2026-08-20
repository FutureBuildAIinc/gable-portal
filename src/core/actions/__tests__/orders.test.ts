// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../../boot';
import { ordersStore, projectsStore, teamStore } from '../../stores/root';
import { listOf } from '../../stores/store';
import {
  createOrder,
  createProject,
  getOrder,
  moveOrderToStage,
  reorderInStage,
  updateOrder,
} from '../orders';

/**
 * Order submission — the point at which a draft becomes a commitment to a
 * supplier, and the point after which the contractor no longer owns the facts.
 *
 * Two things are being defended here. First, that a permission gate exists on
 * every mutation, because the AI assistant calls these exact functions and a
 * gate missing from one of them is a gate the model can walk through. Second,
 * that once the supplier holds an order, the portal stops silently patching
 * logistics — showing a contractor a new delivery date while the truck rolls on
 * the old one is worse than refusing the edit.
 */

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

const MILLER = 'prj_miller';
const PERGOLA = 'ord_miller_pergola'; // seeded empty draft, stage `plan`

/** Act as somebody other than Dana (the owner, who may do everything). */
function actAs(memberId: string): void {
  teamStore.set({ ...teamStore.get(), activeId: memberId });
}

function plannedOrders() {
  return listOf(ordersStore.get())
    .filter((o) => o.stage === 'plan')
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

describe('createOrder', () => {
  it('creates a draft in Plan and inherits the project address', () => {
    const result = createOrder({ projectId: MILLER, name: 'Rail package' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('plan');
    expect(result.value.fulfillment).toBe('delivery');
    // The job site is where materials go by default. Making the contractor
    // re-pick it every time is how an order ends up delivered to the shop.
    expect(result.value.deliveryAddressId).toBe(projectsStore.get().byId[MILLER]?.address?.id);
  });

  it('refuses a blank or whitespace-only name', () => {
    for (const name of ['', '   ', '\t\n']) {
      const result = createOrder({ projectId: MILLER, name });
      expect(result.ok, JSON.stringify(name)).toBe(false);
      expect(result.ok ? '' : result.error).toContain('name');
    }
  });

  it('trims the name rather than storing the padding', () => {
    const result = createOrder({ projectId: MILLER, name: '  Trim package  ' });
    expect(result.ok && result.value.name).toBe('Trim package');
  });

  it('refuses a project that does not exist', () => {
    const result = createOrder({ projectId: 'prj_nope', name: 'Ghost order' });
    expect(result.ok).toBe(false);
  });

  it('appends to the end of the Plan column rather than colliding at 0', () => {
    const before = plannedOrders().length;
    const result = createOrder({ projectId: MILLER, name: 'Appended' });
    expect(result.ok && result.value.sortOrder).toBe(before);
  });

  it('refuses will-call when the dealer does not offer it', () => {
    // `willCall` is a dealer feature flag. Accepting the order and then failing
    // at the counter is the bad version of this.
    const result = createOrder({ projectId: MILLER, name: 'Pickup', fulfillment: 'willcall' });
    if (!result.ok) {
      expect(result.error).toContain('will-call');
    } else {
      // Enabled in the shipped default config — then it must be honoured.
      expect(result.value.fulfillment).toBe('willcall');
    }
  });

  it('is gated: a Field-role user cannot create an order', () => {
    actAs('tm_ty'); // field
    const result = createOrder({ projectId: MILLER, name: 'From the truck' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A refusal that names who CAN act turns a dead end into a next step.
    expect(result.error).toContain('Ty Nguyen');
    expect(result.error).toMatch(/Dana Reyes|Marcus Webb/);
  });

  it('is gated: an A/P user cannot create an order either', () => {
    actAs('tm_robin'); // ap — pays invoices, does not order
    expect(createOrder({ projectId: MILLER, name: 'From the office' }).ok).toBe(false);
  });
});

describe('createProject', () => {
  it('refuses a blank name', () => {
    expect(createProject({ name: '  ' }).ok).toBe(false);
  });

  it('is gated the same way ordering is', () => {
    actAs('tm_ty');
    expect(createProject({ name: 'Field-created job' }).ok).toBe(false);
  });

  it('stores the project so it can immediately take an order', () => {
    const project = createProject({ name: 'New Build', clientName: 'K. Chen', city: 'Brookings' });
    expect(project.ok).toBe(true);
    if (!project.ok) return;

    expect(projectsStore.get().byId[project.value.id]).toBeDefined();
    expect(createOrder({ projectId: project.value.id, name: 'Slab' }).ok).toBe(true);
  });
});

describe('updateOrder', () => {
  it('updates a draft freely', () => {
    const result = updateOrder(PERGOLA, { name: 'Pergola', poNumber: 'PO-4412' });
    expect(result.ok && result.value.name).toBe('Pergola');
    expect(result.ok && result.value.poNumber).toBe('PO-4412');
  });

  it('stamps updatedAt so the board can sort by recency', () => {
    const before = getOrder(PERGOLA)?.updatedAt;
    const result = updateOrder(PERGOLA, { siteInstructions: 'Gate code 4417' });
    expect(result.ok && result.value.updatedAt >= (before ?? '')).toBe(true);
  });

  it('refuses to re-time an order the supplier already holds', () => {
    const placed = listOf(ordersStore.get()).find((o) => o.stage === 'order');
    expect(placed, 'the seeded scenario must contain a placed order').toBeDefined();
    if (!placed) return;

    const result = updateOrder(placed.id, { requestedDate: '2026-12-01T00:00:00.000Z' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Silently patching the date here would show a new date while the truck
    // still rolls on the old one. Reschedule is a supplier conversation.
    expect(result.error).toContain('Reschedule');
    // ...and the stored order is genuinely untouched.
    expect(getOrder(placed.id)?.requestedDate).toBe(placed.requestedDate);
  });

  it('refuses to change fulfillment or PO on a placed order too', () => {
    const placed = listOf(ordersStore.get()).find((o) => o.stage === 'order');
    if (!placed) return;

    expect(updateOrder(placed.id, { fulfillment: 'delivery' }).ok).toBe(false);
    expect(updateOrder(placed.id, { poNumber: 'PO-9999' }).ok).toBe(false);
  });

  it('still allows a non-logistics edit on a placed order', () => {
    const placed = listOf(ordersStore.get()).find((o) => o.stage === 'order');
    if (!placed) return;

    // Site instructions are for the driver, not a change to what the supplier
    // committed to. There is no reason to refuse them.
    const result = updateOrder(placed.id, { siteInstructions: 'Leave at the north stack' });
    expect(result.ok).toBe(true);
  });

  it('refuses an order that no longer exists', () => {
    expect(updateOrder('ord_nope', { name: 'x' }).ok).toBe(false);
  });

  it('is gated', () => {
    actAs('tm_ty');
    expect(updateOrder(PERGOLA, { name: 'Renamed from the field' }).ok).toBe(false);
  });
});

describe('moveOrderToStage', () => {
  it('refuses to submit an empty order to the quote desk', () => {
    // The pergola draft has no lines. Submitting it would put an empty
    // document in front of the dealer's quote desk.
    const result = moveOrderToStage(PERGOLA, 'quote');
    expect(result.ok).toBe(false);
  });

  it('refuses an order that no longer exists', () => {
    expect(moveOrderToStage('ord_nope', 'quote').ok).toBe(false);
  });

  it('is gated on move-stage, and the refusal names who can submit', () => {
    actAs('tm_ty'); // field: may confirm a pickup, may not send orders
    const result = moveOrderToStage(PERGOLA, 'quote');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('send orders to the supplier');
    expect(result.error).toContain('Ty Nguyen');
  });

  it('gates BEFORE it validates, so a refused user learns about permission, not scope', () => {
    // Both would refuse the empty pergola. Which reason comes back matters:
    // telling a field user to add lines sends them to do work they are not
    // allowed to submit anyway.
    actAs('tm_ty');
    const result = moveOrderToStage(PERGOLA, 'quote');
    expect(result.ok ? '' : result.error).toContain('Ty Nguyen');
  });

  it('lets the project manager submit, unlike the field and A/P roles', () => {
    actAs('tm_marcus'); // pm has move-stage
    const result = moveOrderToStage(PERGOLA, 'quote');
    // Still refused — but on scope grounds now, not permission.
    expect(result.ok ? '' : result.error).not.toContain('Marcus Webb');
  });
});

describe('reorderInStage', () => {
  it('renumbers the column contiguously from zero', () => {
    const planned = plannedOrders();
    expect(planned.length).toBeGreaterThan(2);

    const moved = planned[planned.length - 1];
    if (!moved) return;
    reorderInStage(moved.id, 0);

    const after = plannedOrders();
    expect(after[0]?.id).toBe(moved.id);
    // Gaps or duplicates in sortOrder make the next drag land somewhere the
    // contractor did not aim.
    expect(after.map((o) => o.sortOrder)).toEqual(after.map((_, index) => index));
  });

  it('does not disturb orders in other columns', () => {
    const others = listOf(ordersStore.get()).filter((o) => o.stage !== 'plan');
    const before = new Map(others.map((o) => [o.id, o.sortOrder]));

    const planned = plannedOrders();
    if (planned[0]) reorderInStage(planned[0].id, 2);

    for (const order of listOf(ordersStore.get())) {
      if (order.stage === 'plan') continue;
      expect(order.sortOrder, order.id).toBe(before.get(order.id));
    }
  });

  it('refuses an order that no longer exists', () => {
    expect(reorderInStage('ord_nope', 0).ok).toBe(false);
  });

  /**
   * KNOWN DEFECT — see ROADMAP.md §6.
   *
   * Every other mutation in actions/orders.ts opens with
   * `requireCapability(...)`. This one does not, so a Field-role user is
   * refused a stage move and permitted a reorder — an inconsistency in the one
   * layer that is supposed to be the single gate for both the buttons and the
   * AI's tools.
   *
   * It has no callers today (board drag-and-drop goes through
   * `moveOrderToStage`), which is why it has not bitten. It is exported from
   * the core API surface, so it will.
   *
   * `edit-scope` is the right capability: reordering the board is arranging
   * your own work, which is what `edit-scope` covers everywhere else.
   */
  it.fails('is gated like every other mutation', () => {
    actAs('tm_ty'); // field
    const planned = plannedOrders();
    const target = planned[planned.length - 1];
    expect(target).toBeDefined();
    if (!target) return;

    expect(reorderInStage(target.id, 0).ok).toBe(false);
  });

  /**
   * KNOWN DEFECT — see ROADMAP.md §6.
   *
   * The function writes the post-splice index but returns
   * `{ ...order, sortOrder: newSortOrder }` — the argument it was given. For an
   * in-range argument the two agree; for an out-of-range one they do not, and
   * the caller is handed an object that disagrees with the store it just wrote.
   *
   * `Array.prototype.splice` clamps an index beyond the array length, so the
   * order really lands at the end. The returned value should say so.
   */
  it.fails('returns the sortOrder it actually persisted', () => {
    const planned = plannedOrders();
    const target = planned[0];
    expect(target).toBeDefined();
    if (!target) return;

    const result = reorderInStage(target.id, 999);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sortOrder).toBe(getOrder(target.id)?.sortOrder);
  });

  it('currently returns the requested index verbatim — pinning the defect', () => {
    // Delete this in the same commit that fixes the it.fails above.
    const planned = plannedOrders();
    const target = planned[0];
    if (!target) return;

    const result = reorderInStage(target.id, 999);
    expect(result.ok && result.value.sortOrder).toBe(999);
    expect(getOrder(target.id)?.sortOrder).toBe(plannedOrders().length - 1);
  });
});
