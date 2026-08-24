// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Sim } from '../sim/index';
import type { SupplierPort } from './port';

/**
 * The simulator, presented through the port.
 *
 * A pure adapter with no behaviour of its own — every method forwards. That is
 * the point: introducing the seam had to leave the standalone path byte-for-
 * byte identical, so the 451 tests that already assert the simulator's
 * behaviour keep asserting exactly the same thing through one more call frame.
 *
 * `hasQuoteDesk` is true here and false on the wired path, and that asymmetry
 * is the honest one: the simulator really does run a quote desk (see
 * `sim/quote-desk.ts`), and `gable` really has no endpoint for one.
 */
export function createSimSupplier(sim: Sim): SupplierPort {
  return {
    kind: 'sim',
    hasQuoteDesk: true,
    submitToQuoteDesk: (orderId) => sim.submitToQuoteDesk(orderId),
    withdrawFromQuoteDesk: (orderId) => sim.withdrawFromQuoteDesk(orderId),
    // `from` is dropped: the simulator always accepts, so it never rolls back.
    createOrderWithSupplier: (order) => sim.createOrderWithSupplier(order),
    cancelWithSupplier: (orderId) => sim.cancelWithSupplier(orderId),
  };
}
