// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Order, OrderStage } from '../domain/project';

/**
 * The seam between the contractor's side of the counter and the supplier's.
 *
 * `sim/pricing.ts` opens by saying that when a real ERP connects, the simulator
 * is replaced by an API call returning the same shapes and nothing in `domain/`
 * changes. This interface is that claim made testable: two implementations
 * satisfy it — `simSupplier` (the simulator, unchanged) and `gableSupplier`
 * (real HTTP to a running `gable`) — and `actions/` calls neither directly.
 *
 * Every method is fire-and-forget by design, because the four callers are
 * effects of a synchronous stage machine. `domain/stage.ts` decides WHAT should
 * happen and returns effects; the actions layer applies the stage change and
 * then hands each effect here. A promise-returning port would make
 * `moveOrderToStage` async and turn a board drag into a spinner.
 *
 * The real implementation therefore has to make its own progress visible in the
 * stores, and to undo the stage move itself if the ERP refuses. See
 * `gable/supplier.ts`.
 */

export type SupplierKind = 'sim' | 'gable';

export interface SupplierPort {
  /**
   * Which side of the seam is answering. Read by the UI so a board can say
   * "Live — Gable Lumber & Supply" or "Local simulation" and never leave a
   * contractor guessing which one they are looking at.
   */
  readonly kind: SupplierKind;

  /**
   * True when the supplier can price a special-order line.
   *
   * `gable` exposes no quote-desk endpoint on its portal API, so on the wired
   * path this is false and the Quote stage stays portal-local. The UI reads it
   * to label the column rather than pretending a desk is looking at it.
   */
  readonly hasQuoteDesk: boolean;

  submitToQuoteDesk(orderId: string): void;
  withdrawFromQuoteDesk(orderId: string): void;
  /**
   * `order` is already in its NEW stage — the actions layer applies the stage
   * change before dispatching effects, so the supplier sees the order as the
   * contractor now does.
   *
   * `from` is where it came from, and exists solely so a real ERP that refuses
   * the order can put the card back where it was. The simulator ignores it: it
   * cannot refuse. Without this the rollback would have to guess, and guessing
   * "quote" for a card dragged straight from Plan would move the contractor's
   * work to a column they never used.
   */
  createOrderWithSupplier(order: Order, from: OrderStage): void;
  cancelWithSupplier(orderId: string): void;
}
