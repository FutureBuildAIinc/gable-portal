// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '../boot';
import { isEnabled, supplierName } from '../config/runtime';
import type { Order, OrderStage, Project } from '../domain/project';
import { type StageEffect, canMoveToStage, systemAdvanceToInvoice } from '../domain/stage';
import { newId } from '../lib/ids';
import { type Result, err, ok } from '../lib/result';
import { ordersStore, projectsStore, salesOrdersStore, scopeStore } from '../stores/root';
import { listOf, patch, upsert } from '../stores/store';
import { requireCapability } from './team';

/**
 * Every mutation the board can perform.
 *
 * These are the ONLY way order state changes. The board buttons call them and,
 * from M8, the AI's tools call the exact same functions — so an action the
 * assistant takes is indistinguishable from one the contractor took, and the
 * guards cannot be bypassed by going through the model.
 *
 * They return Result rather than throwing so a rejected move can surface its
 * reason in the UI and be handed to the model verbatim.
 */

function itemsForOrder(orderId: string) {
  return listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
}

export function getOrder(orderId: string): Order | undefined {
  return ordersStore.get().byId[orderId];
}

export interface MoveOrderResult {
  order: Order;
  effects: StageEffect[];
}

/**
 * The board drag. Runs the stage machine, and on rejection returns the
 * machine's contractor-readable sentence untouched.
 */
export function moveOrderToStage(orderId: string, to: OrderStage): Result<MoveOrderResult> {
  const gate = requireCapability('move-stage');
  if (!gate.ok) return gate;

  const order = getOrder(orderId);
  if (!order) return err('That order no longer exists.');

  const decision = canMoveToStage(order, to, {
    items: itemsForOrder(orderId),
    now: getContext().clock.nowIso(),
    supplierStatus: order.salesOrderId
      ? salesOrdersStore.get().byId[order.salesOrderId]?.status
      : undefined,
  });
  if (!decision.ok) return decision;

  const { clock, supplier } = getContext();
  const updated: Order = { ...order, stage: to, updatedAt: clock.nowIso() };
  ordersStore.set(patch(ordersStore.get(), orderId, updated));

  // The stage machine decides WHAT should happen; the supplier does it. Effects
  // run after the stage change so the supplier sees the order in its new state.
  //
  // `supplier` is the seam, not `sim`: standalone this is the simulator, wired
  // it is HTTP to a running `gable`, and neither this switch nor anything in
  // `domain/` can tell the difference. The one thing that DOES differ is
  // failure — a real ERP can refuse, and `gable/supplier.ts` walks the stage
  // move back itself when it does.
  for (const effect of decision.value.effects) {
    switch (effect.kind) {
      case 'submit-to-quote-desk':
        supplier.submitToQuoteDesk(orderId);
        break;
      case 'withdraw-from-quote-desk':
        supplier.withdrawFromQuoteDesk(orderId);
        break;
      case 'create-sales-order':
        supplier.createOrderWithSupplier(updated, decision.value.from);
        break;
      case 'cancel-sales-order':
        // `from` for the same reason `create-sales-order` takes it: a real ERP
        // can refuse a cancellation — a fulfilled order, an already-cancelled
        // one, goods on a dispatched route — and the card has to go back to
        // Order rather than sit in Plan as an order the contractor believes
        // they killed.
        supplier.cancelWithSupplier(orderId, decision.value.from);
        break;
    }
  }

  return ok({ order: updated, effects: decision.value.effects });
}

/** Supplier-driven, not contractor-driven. Kept separate so a drag can't reach it. */
export function systemInvoiceOrder(orderId: string): Result<Order> {
  const order = getOrder(orderId);
  if (!order) return err('That order no longer exists.');

  const decision = systemAdvanceToInvoice(order);
  if (!decision.ok) return decision;

  const { clock } = getContext();
  const updated: Order = { ...order, stage: 'invoice', updatedAt: clock.nowIso() };
  ordersStore.set(patch(ordersStore.get(), orderId, updated));
  return ok(updated);
}

export interface CreateOrderInput {
  projectId: string;
  name: string;
  fulfillment?: Order['fulfillment'];
  requestedDate?: string;
}

export function createOrder(input: CreateOrderInput): Result<Order> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  if (input.fulfillment === 'willcall' && !isEnabled('willCall')) {
    return err('This supplier does not offer will-call pickup — orders are delivered.');
  }

  const project = projectsStore.get().byId[input.projectId];
  if (!project) return err('That project no longer exists.');

  const name = input.name.trim();
  if (!name) return err('Give this order a name.');

  const { clock } = getContext();
  const now = clock.nowIso();
  const planCount = listOf(ordersStore.get()).filter((o) => o.stage === 'plan').length;

  const order: Order = {
    id: newId('ord'),
    projectId: input.projectId,
    name,
    stage: 'plan',
    fulfillment: input.fulfillment ?? 'delivery',
    ...(input.requestedDate ? { requestedDate: input.requestedDate } : {}),
    ...(project.address ? { deliveryAddressId: project.address.id } : {}),
    createdAt: now,
    updatedAt: now,
    sortOrder: planCount,
  };

  ordersStore.set(upsert(ordersStore.get(), order));
  return ok(order);
}

export interface CreateProjectInput {
  name: string;
  clientName?: string;
  city?: string;
}

export function createProject(input: CreateProjectInput): Result<Project> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const name = input.name.trim();
  if (!name) return err('Give this project a name.');

  const { clock } = getContext();
  const now = clock.nowIso();
  const id = newId('prj');

  const project: Project = {
    id,
    accountId: 'acct_summit',
    name,
    ...(input.clientName ? { clientName: input.clientName } : {}),
    ...(input.city
      ? { address: { id: `addr_${id}`, line1: '—', city: input.city, state: 'SD', zip: '' } }
      : {}),
    createdAt: now,
    updatedAt: now,
  };

  projectsStore.set(upsert(projectsStore.get(), project));
  return ok(project);
}

export interface UpdateOrderInput {
  name?: string;
  fulfillment?: Order['fulfillment'];
  requestedDate?: string;
  poNumber?: string;
  siteInstructions?: string;
}

export function updateOrder(orderId: string, changes: UpdateOrderInput): Result<Order> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const order = getOrder(orderId);
  if (!order) return err('That order no longer exists.');

  // Once Gable has the order, the date and fulfillment method are supplier
  // facts, not draft fields. Silently patching them here would show the
  // contractor a new date while the truck still rolls on the old one — the
  // reschedule action exists precisely to re-time the supplier's work.
  if (changes.fulfillment === 'willcall' && !isEnabled('willCall')) {
    return err('This supplier does not offer will-call pickup — orders are delivered.');
  }

  const supplierHolds = order.stage === 'order' || order.stage === 'invoice';
  const touchesLogistics =
    changes.requestedDate !== undefined ||
    changes.fulfillment !== undefined ||
    changes.poNumber !== undefined;
  if (supplierHolds && touchesLogistics) {
    return err(
      order.stage === 'order'
        ? `This order is already placed with ${supplierName()}. Use Reschedule on the tracking page to move the date, or pull it back to Plan first.`
        : 'This order has been invoiced and can no longer be changed.',
    );
  }

  const { clock } = getContext();
  const updated: Order = { ...order, ...changes, updatedAt: clock.nowIso() };
  ordersStore.set(patch(ordersStore.get(), orderId, updated));
  return ok(updated);
}

/**
 * Reordering within a board column.
 *
 * Gated on `edit-scope` like the rest of this file: arranging your own board is
 * the same kind of act as building the order on it, and a gate missing from one
 * mutation is a gate the assistant can walk through.
 *
 * The position is clamped into the column rather than trusted, and the clamped
 * position is what both the store and the caller are told — see below.
 */
export function reorderInStage(orderId: string, newSortOrder: number): Result<Order> {
  const gate = requireCapability('edit-scope');
  if (!gate.ok) return gate;

  const order = getOrder(orderId);
  if (!order) return err('That order no longer exists.');

  const siblings = listOf(ordersStore.get())
    .filter((o) => o.stage === order.stage && o.id !== orderId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // `splice` silently clamps an index past the end and reads a NEGATIVE one as
  // an offset from the end, so an out-of-range argument lands somewhere the
  // caller did not ask for. Clamp it here, into a real position in the column,
  // and use that one index for BOTH the write and the return value: the
  // previous version returned the caller's argument while persisting the
  // post-splice index, so an out-of-range drop handed back an order object that
  // disagreed with the store it had just written.
  const requested = Number.isFinite(newSortOrder) ? Math.trunc(newSortOrder) : 0;
  const index = Math.min(Math.max(requested, 0), siblings.length);

  siblings.splice(index, 0, order);

  let collection = ordersStore.get();
  siblings.forEach((sibling, position) => {
    collection = patch(collection, sibling.id, { sortOrder: position });
  });
  ordersStore.set(collection);

  return ok({ ...order, sortOrder: index });
}
