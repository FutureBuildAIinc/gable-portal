// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '../boot';
import { DEMO_ACCOUNT } from '../data/account-seed';
import type { BomTemplate } from '../data/template-seed';
import type { Product } from '../domain/catalog';
import type { Uom } from '../domain/catalog';
import { SPECIAL_ORDER_PREFIX, type ScopeItem } from '../domain/project';
import { newId } from '../lib/ids';
import { type Result, err, ok } from '../lib/result';
import { catalogStore, ordersStore, scopeStore } from '../stores/root';
import { listOf, patch, remove, upsert } from '../stores/store';
import { requireCapability } from './team';

/**
 * Scope editing. Same rule as the order actions: this is the only way line
 * items change, so the AI's tools in M8 inherit the pricing and validation
 * behaviour for free rather than reimplementing it.
 */

const ACCOUNT = { accountId: DEMO_ACCOUNT.id, tierId: DEMO_ACCOUNT.pricingTierId };

function itemsForOrder(orderId: string): ScopeItem[] {
  return listOf(scopeStore.get())
    .filter((item) => item.orderId === orderId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function findProduct(productIdOrSku: string): Product | undefined {
  const { products } = catalogStore.get();
  return products.find(
    (product) => product.id === productIdOrSku || product.sku === productIdOrSku,
  );
}

/**
 * Orders that already exist on the supplier's side must not be edited
 * underneath them — the contractor would be changing a scope the dealer has
 * already priced or picked.
 */
function assertEditable(orderId: string): Result<true> {
  const order = ordersStore.get().byId[orderId];
  if (!order) return err('That order no longer exists.');
  if (order.stage === 'quote') {
    return err('This order is with the quote desk. Pull it back to Plan to change the scope.');
  }
  if (order.stage === 'order' || order.stage === 'invoice') {
    return err('This order has already been placed and cannot be changed.');
  }
  return ok(true);
}

export interface AddCatalogItemInput {
  orderId: string;
  /** Product id or SKU. */
  product: string;
  qty: number;
  notes?: string;
  addedBy?: 'user' | 'assistant';
}

export function addCatalogItem(input: AddCatalogItemInput): Result<ScopeItem> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const editable = assertEditable(input.orderId);
  if (!editable.ok) return editable;

  const product = findProduct(input.product);
  if (!product) return err(`No product matches "${input.product}".`);
  if (input.qty <= 0) return err('Quantity must be at least 1.');

  const { pricing, clock } = getContext();
  const existing = itemsForOrder(input.orderId);

  // Adding the same SKU twice bumps the quantity instead of creating a second
  // line — two lines for one product is a data-entry mistake, not intent, and
  // it would also hide a volume break that the combined quantity qualifies for.
  const duplicate = existing.find((item) => item.productId === product.id);
  if (duplicate) {
    return updateItemQty(duplicate.id, duplicate.qty + input.qty);
  }

  const quote = pricing.quote(product, input.qty, ACCOUNT);
  const item: ScopeItem = {
    id: newId('si'),
    orderId: input.orderId,
    kind: 'catalog',
    productId: product.id,
    snapshot: {
      sku: product.sku,
      name: product.name,
      ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
      leadTimeDays: product.leadTimeDays,
    },
    qty: input.qty,
    uom: product.baseUom,
    ...(input.notes ? { notes: input.notes } : {}),
    unitPrice: quote.unitPrice,
    listPrice: quote.listPrice,
    priceSource: 'erp',
    addedBy: input.addedBy ?? 'user',
    addedAt: clock.nowIso(),
    sortOrder: existing.length,
  };

  scopeStore.set(upsert(scopeStore.get(), item));
  return ok(item);
}

export interface AddSpecialItemInput {
  orderId: string;
  description: string;
  qty: number;
  uom?: Uom;
  /** The contractor's own guess, clearly labelled as an estimate. */
  estimatedUnitPrice?: number;
  addedBy?: 'user' | 'assistant';
}

/**
 * A line the dealer doesn't stock. The synthesised `SO-` sku is what makes the
 * quote-desk gate fire, so a contractor can capture "custom mahogany door"
 * without inventing a price nobody has agreed to.
 */
export function addSpecialItem(input: AddSpecialItemInput): Result<ScopeItem> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const editable = assertEditable(input.orderId);
  if (!editable.ok) return editable;

  const description = input.description.trim();
  if (!description) return err('Describe the item so the dealer can price it.');
  if (input.qty <= 0) return err('Quantity must be at least 1.');

  const { clock } = getContext();
  const existing = itemsForOrder(input.orderId);

  const item: ScopeItem = {
    id: newId('si'),
    orderId: input.orderId,
    kind: 'special',
    snapshot: {
      sku: `${SPECIAL_ORDER_PREFIX}${newId('').replace('_', '').toUpperCase().slice(0, 6)}`,
      name: description,
    },
    qty: input.qty,
    uom: input.uom ?? 'EA',
    ...(input.estimatedUnitPrice !== undefined
      ? { unitPrice: input.estimatedUnitPrice, priceSource: 'estimate' as const }
      : { priceSource: 'unpriced' as const }),
    addedBy: input.addedBy ?? 'user',
    addedAt: clock.nowIso(),
    sortOrder: existing.length,
  };

  scopeStore.set(upsert(scopeStore.get(), item));
  return ok(item);
}

export interface QtyChange {
  item: ScopeItem;
  /** Set when the new quantity crossed a volume break and moved the price. */
  priceChanged?: { from: number; to: number };
}

/**
 * Changing quantity re-asks the ERP for a price, because volume breaks make
 * price quantity-dependent. Silently keeping a stale unit price would be the
 * kind of quiet wrongness that destroys trust in the numbers.
 */
export function updateItemQty(itemId: string, qty: number): Result<ScopeItem> {
  const result = updateItemQtyDetailed(itemId, qty);
  return result.ok ? ok(result.value.item) : result;
}

export function updateItemQtyDetailed(itemId: string, qty: number): Result<QtyChange> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const item = scopeStore.get().byId[itemId];
  if (!item) return err('That line no longer exists.');

  const editable = assertEditable(item.orderId);
  if (!editable.ok) return editable;
  if (qty <= 0) return err('Quantity must be at least 1. Remove the line instead.');

  let updated: ScopeItem = { ...item, qty };
  let priceChanged: QtyChange['priceChanged'];

  if (item.kind === 'catalog' && item.productId) {
    const product = findProduct(item.productId);
    if (product) {
      const quote = getContext().pricing.quote(product, qty, ACCOUNT);
      if (item.unitPrice !== undefined && quote.unitPrice !== item.unitPrice) {
        priceChanged = { from: item.unitPrice, to: quote.unitPrice };
      }
      updated = { ...updated, unitPrice: quote.unitPrice, listPrice: quote.listPrice };
    }
  }

  scopeStore.set(patch(scopeStore.get(), itemId, updated));
  return ok({ item: updated, ...(priceChanged ? { priceChanged } : {}) });
}

export function removeItem(itemId: string): Result<true> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const item = scopeStore.get().byId[itemId];
  if (!item) return err('That line no longer exists.');

  const editable = assertEditable(item.orderId);
  if (!editable.ok) return editable;

  scopeStore.set(remove(scopeStore.get(), itemId));
  return ok(true);
}

export function updateItemNotes(itemId: string, notes: string): Result<ScopeItem> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const item = scopeStore.get().byId[itemId];
  if (!item) return err('That line no longer exists.');

  const updated: ScopeItem = { ...item, notes };
  scopeStore.set(patch(scopeStore.get(), itemId, updated));
  return ok(updated);
}

export interface ApplyTemplateResult {
  added: number;
  merged: number;
}

/** Adds every line in a starter BoM, merging into any SKU already on the order. */
export function applyTemplate(
  orderId: string,
  template: BomTemplate,
  addedBy: 'user' | 'assistant' = 'user',
): Result<ApplyTemplateResult> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const editable = assertEditable(orderId);
  if (!editable.ok) return editable;

  const before = new Set(itemsForOrder(orderId).map((item) => item.productId));
  let added = 0;
  let merged = 0;

  for (const line of template.items) {
    const result = addCatalogItem({
      orderId,
      product: line.productId,
      qty: line.qty,
      addedBy,
      ...(line.notes ? { notes: line.notes } : {}),
    });
    if (!result.ok) continue;
    if (before.has(line.productId)) merged++;
    else added++;
  }

  if (added === 0 && merged === 0) return err('None of that template matched the catalog.');
  return ok({ added, merged });
}

/**
 * Re-prices every line against the current ERP rules. Used after a dealer
 * pricing change and by the M4 simulator when a quote comes back.
 */
export function repriceOrder(orderId: string): Result<number> {
  const editable = assertEditable(orderId);
  if (!editable.ok) return editable;

  const { pricing } = getContext();
  let collection = scopeStore.get();
  let changed = 0;

  for (const item of itemsForOrder(orderId)) {
    if (item.kind !== 'catalog' || !item.productId) continue;
    const product = findProduct(item.productId);
    if (!product) continue;

    const quote = pricing.quote(product, item.qty, ACCOUNT);
    if (quote.unitPrice !== item.unitPrice) {
      collection = patch(collection, item.id, {
        unitPrice: quote.unitPrice,
        listPrice: quote.listPrice,
      });
      changed++;
    }
  }

  scopeStore.set(collection);
  return ok(changed);
}
