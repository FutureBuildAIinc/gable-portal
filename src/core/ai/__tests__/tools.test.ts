// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../../boot';
import { catalogStore, ordersStore, scopeStore } from '../../stores/root';
import { listOf } from '../../stores/store';
import { buildSystemPrompt } from '../prompt';
import { TOOLS, type ToolDef, toolByName, toolSchemas } from '../tools';

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

const PERGOLA = 'ord_miller_pergola'; // seeded empty draft
const MILLER_FRAME = 'ord_miller_frame'; // fully ERP-priced

function call(name: string, input: Record<string, unknown> = {}) {
  const tool = toolByName(name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.run(input);
}

function itemsOf(orderId: string) {
  return listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
}

beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

describe('the registry', () => {
  it('exposes unique names', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The confirmation prompt is the ONLY thing standing between the model and a
   * real purchase, so a commit tool without one would silently fall back to
   * "Run pay_invoices?" — which tells the contractor nothing about the amount.
   */
  it('gives every commit tool a confirmation prompt', () => {
    for (const tool of TOOLS.filter((entry) => entry.tier === 'commit')) {
      expect(tool.confirm, `${tool.name} has no confirm()`).toBeTypeOf('function');
    }
  });

  it('never sends tier, confirm, or run to the API', () => {
    for (const schema of toolSchemas()) {
      expect(Object.keys(schema).sort()).toEqual(['description', 'input_schema', 'name']);
    }
  });

  it('declares an object schema for every tool', () => {
    for (const tool of TOOLS) {
      expect(tool.input_schema.type).toBe('object');
      for (const key of tool.input_schema.required ?? []) {
        expect(Object.keys(tool.input_schema.properties)).toContain(key);
      }
    }
  });
});

describe('reads', () => {
  it('leaves state untouched', () => {
    const before = { orders: ordersStore.get(), scope: scopeStore.get() };
    for (const tool of TOOLS.filter((entry) => entry.tier === 'read')) {
      tool.run({ orderId: MILLER_FRAME, query: 'stud' });
    }
    // Snapshots are compared by reference, which is exactly how the UI decides
    // whether to re-render.
    expect(ordersStore.get()).toBe(before.orders);
    expect(scopeStore.get()).toBe(before.scope);
  });

  it('reports the board with the moves each card can actually make', () => {
    const result = call('get_board');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const columns = result.value as { stage: string; orders: { orderId: string }[] }[];
    const plan = columns.find((column) => column.stage === 'plan');
    expect(plan?.orders.map((order) => order.orderId)).toContain(MILLER_FRAME);
  });

  it('explains itself when the order id is wrong instead of returning nothing', () => {
    const result = call('get_order', { orderId: 'ord_nope' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('get_board');
  });
});

describe('writes', () => {
  it('adds a catalog line through the same action the UI uses', () => {
    const found = call('search_catalog', { query: '2x4' });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const first = (found.value as { productId: string }[])[0];
    expect(first).toBeDefined();
    if (!first) return;

    const added = call('add_materials', { orderId: PERGOLA, product: first.productId, qty: 40 });
    expect(added.ok).toBe(true);

    const [line] = itemsOf(PERGOLA);
    expect(line?.qty).toBe(40);
    // Attribution matters: the contractor should be able to see what the
    // assistant put on their order.
    expect(line?.addedBy).toBe('assistant');
    expect(line?.unitPrice).toBeGreaterThan(0);
  });

  it('cannot invent a price for something off-catalog', () => {
    const added = call('add_special_order_item', {
      orderId: PERGOLA,
      description: 'Custom mahogany entry door, 42in',
      qty: 1,
    });
    expect(added.ok).toBe(true);

    const [line] = itemsOf(PERGOLA);
    expect(line?.snapshot.sku.startsWith('SO-')).toBe(true);
    expect(line?.unitPrice).toBeUndefined();
  });
});

describe('commits', () => {
  it('hands the guard sentence back verbatim rather than throwing', () => {
    call('add_special_order_item', { orderId: PERGOLA, description: 'Custom door', qty: 1 });

    const moved = call('move_order_stage', { orderId: PERGOLA, stage: 'order' });
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    // The same sentence the contractor sees on a rejected drop.
    expect(moved.error).toMatch(/needs? dealer pricing/i);
  });

  it('refuses the stage only the supplier may set', () => {
    const moved = call('move_order_stage', { orderId: MILLER_FRAME, stage: 'invoice' });
    expect(moved.ok).toBe(false);
  });

  it('rejects a stage that does not exist', () => {
    const moved = call('move_order_stage', { orderId: MILLER_FRAME, stage: 'shipped' });
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error).toContain('plan');
  });

  it('names the order and the destination in the confirmation, not the tool', () => {
    const tool = toolByName('move_order_stage') as ToolDef;
    const prompt = tool.confirm?.({ orderId: MILLER_FRAME, stage: 'quote' }) ?? '';
    expect(prompt).toContain(ordersStore.get().byId[MILLER_FRAME]?.name);
    expect(prompt).toContain('quote desk');
  });

  it('states the amount before any invoice is paid', () => {
    const open = call('get_open_invoices');
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    const { invoices } = open.value as { invoices: { invoiceId: string; balance: string }[] };
    const first = invoices[0];
    expect(first).toBeDefined();
    if (!first) return;

    const tool = toolByName('pay_invoices') as ToolDef;
    const prompt = tool.confirm?.({ invoiceIds: [first.invoiceId] }) ?? '';
    expect(prompt).toContain(first.balance);
    expect(prompt).toContain('1 invoice');
  });

  it('will not send a customer quote that was never built', () => {
    const sent = call('send_customer_quote', { orderId: PERGOLA });
    expect(sent.ok).toBe(false);
  });
});

describe('the brief', () => {
  it('inlines every SKU, which is what makes matching work without a search round trip', () => {
    const prompt = buildSystemPrompt();
    for (const product of catalogStore.get().products) {
      expect(prompt).toContain(product.sku);
    }
  });

  it('tells the model it is not doing takeoff math', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/never invent or adjust a quantity/i);
    expect(prompt).toMatch(/not calculating a takeoff/i);
  });
});
