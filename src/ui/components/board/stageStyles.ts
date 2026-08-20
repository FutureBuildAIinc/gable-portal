// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { supplierName } from '@core/config/runtime';
import type { OrderStage } from '@core/domain/project';

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
  return {
    plan: 'Building the scope. Your pricing is live here.',
    quote: `With the ${supplierName()} quote desk for pricing.`,
    order: 'Placed and on its way.',
    invoice: 'Delivered and billed — ready to pay.',
  }[stage];
}

/**
 * Empty-column copy. Where a card ARRIVES by dragging, the copy names the
 * gesture — press-and-hold is invisible otherwise, and nothing else on the
 * board teaches it.
 */
export function stageEmpty(stage: OrderStage): string {
  return {
    plan: 'Nothing being planned. Start an order to build a scope.',
    quote: `Nothing at the quote desk. Press and hold a card, then drag it here to have ${supplierName()} price it.`,
    order: 'No orders placed yet. Press and hold a priced card and drag it here to place it.',
    invoice: 'No open invoices. Nice.',
  }[stage];
}
