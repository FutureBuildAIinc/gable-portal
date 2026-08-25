// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrder, moveOrderToStage } from '../../actions/orders';
import { addCatalogItem } from '../../actions/scope';
import { boot, getContext, installSupplier } from '../../boot';
import { err, ok } from '../../lib/result';
import { addDays } from '../../lib/time';
import { catalogStore, ordersStore, projectsStore } from '../../stores/root';
import { listOf } from '../../stores/store';
import type { SupplierPort } from '../port';

/**
 * The seam itself, independent of either implementation.
 *
 * Two properties are being defended. First, that the DEFAULT is the simulator —
 * `boot()` must never reach the network, because an unreachable ERP has to
 * degrade to a sign-in prompt and not to a blank app. Second, that swapping the
 * supplier is a swap and not a reboot: a re-boot would reseed and restart the
 * scheduler, which is the opposite of what connecting is for.
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

function spyPort(): SupplierPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    kind: 'gable',
    capabilities: {
      quoteDesk: true,
      quoteDecisions: true,
      cancellation: true,
      projectAssociation: true,
      reschedule: 'requests',
      leadTimes: true,
      volumeBreaks: true,
      categoryTree: true,
      changeFeed: true,
    },
    submitToQuoteDesk: (orderId) => void calls.push(`quote:${orderId}`),
    withdrawFromQuoteDesk: (orderId) => void calls.push(`withdraw:${orderId}`),
    createOrderWithSupplier: (order, from) => void calls.push(`order:${order.id}:${from}`),
    cancelWithSupplier: (orderId, from) => void calls.push(`cancel:${orderId}:${from}`),
    requestReschedule: async (orderId, date) => {
      calls.push(`reschedule:${orderId}:${date}`);
      return ok({
        applied: false,
        requestedDate: date,
        status: 'PENDING',
        message: 'Requested — not confirmed.',
      });
    },
    decideQuote: async (orderId, decision) => {
      calls.push(`decide:${orderId}:${decision}`);
      return err('stub');
    },
    attachOrderToProject: async (supplierOrderId, projectId) => {
      calls.push(`attach:${supplierOrderId}:${projectId}`);
      return ok(undefined);
    },
  };
}

describe('boot is standalone and offline', () => {
  it('installs the simulator, which owns a quote desk', () => {
    boot({ reset: true });

    expect(getContext().supplier.kind).toBe('sim');
    expect(getContext().supplier.capabilities.quoteDesk).toBe(true);
  });

  it('declares a reschedule it can genuinely apply, and no change feed', () => {
    boot({ reset: true });

    // The simulator IS the supplier, so a date it moves has moved. Anything
    // that only records an ask must say `requests` — see `supplier/port.ts`.
    expect(getContext().supplier.capabilities.reschedule).toBe('applies');
    // There is no network poll in-process, so there is no conditional read to
    // claim. Setting this true to make a badge tidy would be the exact class
    // of claim the capability flags exist to prevent.
    expect(getContext().supplier.capabilities.changeFeed).toBe(false);
    // And no accept/decline ceremony: the desk writes prices onto the lines.
    expect(getContext().supplier.capabilities.quoteDecisions).toBe(false);
  });

  it('seeds a catalog without asking anyone', () => {
    boot({ reset: true });

    expect(catalogStore.get().products.length).toBeGreaterThan(0);
  });
});

describe('the actions layer routes every supplier effect through the port', () => {
  it('hands a quote-desk submission to whichever supplier is installed', () => {
    boot({ reset: true });
    const port = spyPort();
    installSupplier({
      supplier: port,
      pricing: getContext().pricing,
      catalog: catalogStore.get(),
    });

    const planned = listOf(ordersStore.get()).find(
      (order) => order.stage === 'plan' && order.id !== undefined,
    );
    const drafted = planned?.id;
    expect(drafted).toBeDefined();

    // Whether the move is allowed is the stage machine's business; what matters
    // here is that nothing calls `sim` directly any more.
    moveOrderToStage(String(drafted), 'quote');

    expect(port.calls.some((call) => call.startsWith('quote:'))).toBe(true);
  });

  it('tells the supplier which stage a rejected order should return to', () => {
    boot({ reset: true });
    const port = spyPort();
    installSupplier({
      supplier: port,
      pricing: getContext().pricing,
      catalog: catalogStore.get(),
    });

    // Built here rather than borrowed from the scenario, because the whole
    // point is a card that goes straight from Plan to Order — the case a
    // hardcoded rollback target would get wrong.
    const project = listOf(projectsStore.get())[0];
    if (!project) throw new Error('expected the scenario to have left a project');
    const created = createOrder({
      projectId: project.id,
      name: 'Straight to order',
      requestedDate: addDays(getContext().clock.nowIso(), 7),
    });
    if (!created.ok) throw new Error(created.error);
    const sku = catalogStore.get().products[0]?.sku;
    const added = addCatalogItem({ orderId: created.value.id, product: String(sku), qty: 10 });
    if (!added.ok) throw new Error(added.error);

    const moved = moveOrderToStage(created.value.id, 'order');
    if (!moved.ok) throw new Error(`expected the move to be allowed: ${moved.error}`);

    // Without `from`, a rollback would have to guess, and guessing "quote" for
    // a card dragged straight from Plan moves work to a column never used.
    expect(port.calls).toContain(`order:${created.value.id}:plan`);
  });
});

describe('installSupplier swaps rather than reboots', () => {
  it('replaces catalog and pricing in one assignment', () => {
    boot({ reset: true });
    const before = catalogStore.get().products.length;

    const pricing = { quote: vi.fn(), quoteAll: vi.fn() } as never;
    installSupplier({
      supplier: spyPort(),
      pricing,
      catalog: { products: [], categories: [], brands: [], locations: [] },
    });

    // One window in which ERP products could be priced by simulated tiers is
    // one window too many — hence a single call, not two.
    expect(before).toBeGreaterThan(0);
    expect(catalogStore.get().products).toHaveLength(0);
    expect(getContext().pricing).toBe(pricing);
    expect(getContext().supplier.kind).toBe('gable');
  });

  it('leaves the clock and the sim in place, so demo controls keep working', () => {
    boot({ reset: true });
    const { clock, sim } = getContext();

    installSupplier({
      supplier: spyPort(),
      pricing: getContext().pricing,
      catalog: catalogStore.get(),
    });

    expect(getContext().clock).toBe(clock);
    expect(getContext().sim).toBe(sim);
  });

  it('throws rather than silently doing nothing if boot has not run', async () => {
    // A fresh module graph: `context` is null and there is nothing to swap.
    vi.resetModules();
    const fresh = await import('../../boot');
    expect(() =>
      fresh.installSupplier({
        supplier: spyPort(),
        pricing: { quote: vi.fn(), quoteAll: vi.fn() } as never,
        catalog: { products: [], categories: [], brands: [], locations: [] },
      }),
    ).toThrow(/boot/);
  });
});
