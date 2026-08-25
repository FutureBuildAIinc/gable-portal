// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { supplierName } from '../config/runtime';
import { err, ok } from '../lib/result';
import { formatDate } from '../lib/time';
import type { Sim } from '../sim/index';
import type { SupplierCapabilities, SupplierPort } from './port';

/**
 * The simulator, presented through the port.
 *
 * Almost a pure adapter: every method forwards to `sim/`, and that is the
 * point — introducing the seam had to leave the standalone path behaving
 * identically, so the tests that already assert the simulator's behaviour keep
 * asserting exactly the same thing through one more call frame.
 *
 * The capabilities below are the honest inventory of what an in-process
 * simulator can and cannot model, and two of them are false on purpose:
 *
 *  - **`quoteDecisions`.** `sim/quote-desk.ts` prices the special-order lines
 *    and writes the numbers straight onto the scope. There is no SENT state to
 *    accept and no dealer waiting on an answer, so there is nothing to accept.
 *    Returning a fake "accepted" would invent a ceremony that never happened.
 *  - **`changeFeed`.** The simulator writes into the same stores the UI reads.
 *    There is no poll to make conditional, so claiming a change feed would be
 *    claiming an optimisation of a network round trip that does not exist.
 *
 * `reschedule` is `'applies'`, and that asymmetry with the wired path is the
 * most important one in this file: the simulator IS the whole supplier, so
 * when it moves a date the date has genuinely moved. `gable` cannot say that
 * and does not — see `supplier/port.ts`.
 */

const SIM_CAPABILITIES: SupplierCapabilities = {
  // A real desk, simulated: it takes hours, it prices special-order lines, and
  // the price expires. See `sim/quote-desk.ts`.
  quoteDesk: true,
  quoteDecisions: false,
  cancellation: true,
  // There is no supplier-side project record: a project is a portal-local
  // grouping in the standalone build, and nothing outside the browser knows
  // about it.
  projectAssociation: false,
  reschedule: 'applies',
  // Every seeded product carries one — `data/catalog-seed.ts` derives it from
  // stock rather than leaving it blank.
  leadTimes: true,
  volumeBreaks: true,
  categoryTree: true,
  changeFeed: false,
};

export function createSimSupplier(sim: Sim): SupplierPort {
  return {
    kind: 'sim',
    capabilities: SIM_CAPABILITIES,
    submitToQuoteDesk: (orderId) => sim.submitToQuoteDesk(orderId),
    withdrawFromQuoteDesk: (orderId) => sim.withdrawFromQuoteDesk(orderId),
    // `from` is dropped: the simulator always accepts, so it never rolls back.
    createOrderWithSupplier: (order) => sim.createOrderWithSupplier(order),
    cancelWithSupplier: (orderId) => sim.cancelWithSupplier(orderId),

    requestReschedule: async (orderId, date) => {
      const applied = sim.applyReschedule(orderId, date);
      if (!applied) return err(`This order is not with ${supplierName()} yet.`);
      return ok({
        // True, and the only implementation entitled to say so.
        applied: true,
        requestedDate: applied.promisedDate,
        currentScheduledDate: applied.promisedDate,
        status: 'APPLIED',
        message: `Moved to ${formatDate(applied.promisedDate)}.`,
      });
    },

    /**
     * Stated, not simulated. The simulated desk has no accept/decline step: it
     * prices the lines and the contractor places the order. Inventing an
     * acceptance here would teach a flow the standalone build cannot honour
     * and the wired build implements differently.
     */
    decideQuote: async () =>
      err(
        `The ${supplierName()} simulator prices a quote straight onto your lines — there is no accept or decline step to take. Place the order when you are ready.`,
      ),

    attachOrderToProject: async () =>
      err(
        'Running standalone, every order on this board already belongs to a job — there is no supplier-side order history to attach.',
      ),
  };
}
