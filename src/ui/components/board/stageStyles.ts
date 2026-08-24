// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import type { OrderStage } from '@core/domain/project';

/**
 * Does a real ERP answer for this deployment?
 *
 * The board copy has to change with the answer. "With the quote desk for
 * pricing" is true of the simulator and false of `gable`, which has no
 * quote-desk endpoint at all — leaving that sentence up on a wired board would
 * tell a contractor a person is looking at their scope when nobody is.
 */
function wired(): boolean {
  try {
    return getContext().supplier.kind === 'gable';
  } catch {
    // Rendered before boot in a test harness. Standalone is the safe answer.
    return false;
  }
}

/**
 * Stage colour is platform-owned, never dealer-overridable — an order in
 * "Order" must look the same in every dealer's portal.
 */
export const STAGE_VAR: Record<OrderStage, string> = {
  plan: 'var(--stage-plan)',
  quote: 'var(--stage-quote)',
  order: 'var(--stage-order)',
  invoice: 'var(--stage-invoice)',
};

/**
 * One-line explanation of what each column means, for empty states and headers.
 *
 * Functions, not constants: the supplier's name is configured per deployment,
 * and a module-level object would freeze whatever was injected at import.
 */
export function stageBlurb(stage: OrderStage): string {
  const live = wired();
  return {
    // Plan is portal-local in BOTH modes — the dealer's ERP never sees a scope
    // being drafted, and saying so is the difference between a working notebook
    // and a promise nobody made.
    plan: live
      ? 'Building the scope. Only you can see this — nothing is sent to the supplier yet.'
      : 'Building the scope. Your pricing is live here.',
    quote: live
      ? `Waiting on a price. ${supplierName()}'s system has no quote desk this portal can reach — this is your own record until you call them.`
      : `With the ${supplierName()} quote desk for pricing.`,
    order: live
      ? `Placed in ${supplierName()}'s system. Status comes from them.`
      : 'Placed and on its way.',
    invoice: 'Delivered and billed — ready to pay.',
  }[stage];
}

/**
 * Empty-column copy. Where a card ARRIVES by dragging, the copy names the
 * gesture — press-and-hold is invisible otherwise, and nothing else on the
 * board teaches it.
 */
export function stageEmpty(stage: OrderStage): string {
  const live = wired();
  return {
    plan: 'Nothing being planned. Start an order to build a scope.',
    quote: live
      ? 'Nothing waiting on a price. Drag a card here to park a scope that still needs a number from your rep.'
      : `Nothing at the quote desk. Press and hold a card, then drag it here to have ${supplierName()} price it.`,
    order: live
      ? `No orders placed yet. Press and hold a priced card and drag it here to send it to ${supplierName()}.`
      : 'No orders placed yet. Press and hold a priced card and drag it here to place it.',
    invoice: 'No open invoices. Nice.',
  }[stage];
}
