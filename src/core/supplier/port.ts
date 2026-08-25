// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Order, OrderStage } from '../domain/project';
import type { Quote } from '../domain/supplier';
import type { Result } from '../lib/result';
import type { IsoDateTime } from '../lib/time';

/**
 * The seam between the contractor's side of the counter and the supplier's.
 *
 * `sim/pricing.ts` opens by saying that when a real ERP connects, the simulator
 * is replaced by an API call returning the same shapes and nothing in `domain/`
 * changes. This interface is that claim made testable: two implementations
 * satisfy it — `simSupplier` (the simulator, unchanged) and `gableSupplier`
 * (real HTTP to a running `gable`) — and `actions/` calls neither directly.
 *
 * There are two kinds of method here and the split is deliberate:
 *
 *  1. **Stage effects** — `submitToQuoteDesk`, `withdrawFromQuoteDesk`,
 *     `createOrderWithSupplier`, `cancelWithSupplier`. Fire-and-forget, because
 *     the four callers are effects of a SYNCHRONOUS stage machine.
 *     `domain/stage.ts` decides WHAT should happen and returns effects; the
 *     actions layer applies the stage change and then hands each effect here. A
 *     promise-returning effect would make `moveOrderToStage` async and turn a
 *     board drag into a spinner. The real implementation therefore has to make
 *     its own progress visible in the stores, and to undo the stage move itself
 *     if the ERP refuses. See `gable/supplier.ts`.
 *
 *  2. **Asked-and-answered calls** — `requestReschedule`, `decideQuote`,
 *     `attachOrderToProject`. These are not stage effects; a contractor pressed
 *     a button and is waiting for the supplier's answer, and the answer can be
 *     a refusal with a reason they need to read. Faking those synchronously
 *     would mean showing "moved to Friday" before anyone had agreed to it.
 */

export type SupplierKind = 'sim' | 'gable';

/**
 * How a supplier answers "move this delivery".
 *
 * The distinction is the whole reason this is not a boolean. `gable` returns
 * 202 with `applied: false` and NEVER writes `delivery_routes` — the date is a
 * property of a shared route and a dispatcher owns it. The simulator, being
 * the whole supplier, really does move the date. A UI that rendered both as
 * "done" would tell a contractor their Tuesday delivery is now Friday when
 * nobody at the dealer has agreed to anything.
 */
export type RescheduleMode =
  /** The supplier moved it. The new date is real. */
  | 'applies'
  /** The ask was recorded. A human decides. The date has NOT changed. */
  | 'requests'
  /** No mechanism at all — refuse rather than write a local promise. */
  | 'none';

/**
 * What each side of the seam can actually do.
 *
 * Read by the UI so a capability that is genuinely wired stops apologising for
 * itself, and one that is not keeps its label. The rule is one-directional:
 * a flag may only be true when there is a real endpoint or a real simulation
 * behind it. Setting one to make a badge disappear is the failure this whole
 * integration exists to correct.
 */
export interface SupplierCapabilities {
  /**
   * The supplier will price a scope it is sent, including lines that are not
   * in its catalog. True on both sides now: the simulator runs
   * `sim/quote-desk.ts`, and `gable` has `POST /api/portal/v1/quotes`, whose
   * request carries a scope and deliberately no price field.
   */
  readonly quoteDesk: boolean;
  /**
   * A priced quote can be accepted or declined through the supplier. Only
   * `gable` has this — the simulator's desk writes prices onto the scope and
   * has no accept/decline step to model.
   */
  readonly quoteDecisions: boolean;
  /** An order already placed can be cancelled through the supplier. */
  readonly cancellation: boolean;
  /** The supplier stores which job an order belongs to. */
  readonly projectAssociation: boolean;
  readonly reschedule: RescheduleMode;
  /** The supplier publishes a lead time per product — possibly a null one. */
  readonly leadTimes: boolean;
  /** The supplier publishes a per-customer quantity ladder. */
  readonly volumeBreaks: boolean;
  /** The supplier publishes a browsable category hierarchy. */
  readonly categoryTree: boolean;
  /**
   * The supplier supports a conditional, cursored read of what has changed —
   * so the portal can stop re-transferring an unchanged order list every 30
   * seconds. False for the simulator, which is in-process and has no poll.
   */
  readonly changeFeed: boolean;
}

/** What the supplier did with a reschedule ask. */
export interface RescheduleOutcome {
  /**
   * True ONLY when the supplier actually moved the date.
   *
   * Branch on this, never on the status string. `gable` files a PENDING
   * request and answers `applied: false`; the simulator answers `true`.
   */
  applied: boolean;
  /** The date that was asked for. */
  requestedDate: IsoDateTime;
  /**
   * What the supplier's own board says today, when it told us. Present so a
   * consumer can show the ask next to the current answer without a second
   * call — and so "requested Friday, still scheduled Tuesday" is renderable.
   */
  currentScheduledDate?: IsoDateTime;
  /** The supplier's own word: 'APPLIED', 'PENDING', 'DECLINED', 'SUPERSEDED'. */
  status: string;
  /** One sentence for the contractor. Written by whoever can honour it. */
  message: string;
}

/** Accept or decline, as the contractor's answer to a priced quote. */
export type QuoteDecision = 'accept' | 'decline';

export interface SupplierPort {
  /**
   * Which side of the seam is answering. Read by the UI so a board can say
   * "Live — Gable Lumber & Supply" or "Local simulation" and never leave a
   * contractor guessing which one they are looking at.
   */
  readonly kind: SupplierKind;

  readonly capabilities: SupplierCapabilities;

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
  /**
   * `from` is here for the same reason it is on `createOrderWithSupplier`, and
   * it earns its place now that the far side can say no: `gable` refuses to
   * cancel a fulfilled order, an already-cancelled one, and goods on a
   * dispatched route. A card dragged back to Plan on a cancellation the dealer
   * then refused has to return to Order, or the board shows an order the
   * contractor believes they killed.
   */
  cancelWithSupplier(orderId: string, from: OrderStage): void;

  /**
   * Ask for a different delivery day for a board order.
   *
   * Returns what the supplier DID, not what was asked — see `RescheduleOutcome.
   * applied`. A refusal comes back as `err` carrying the supplier's own
   * sentence.
   */
  requestReschedule(orderId: string, date: IsoDateTime): Promise<Result<RescheduleOutcome>>;

  /**
   * Accept or decline the supplier's priced quote for a board order.
   *
   * Refused with the supplier's own reason when the quote is not decidable —
   * on `gable` that is a 409 `QUOTE_NOT_PRICED`, which covers both "not priced
   * yet" and "already closed".
   */
  decideQuote(orderId: string, decision: QuoteDecision): Promise<Result<Quote>>;

  /**
   * Attach a supplier-side order to one of the contractor's jobs, or detach it
   * with `null`.
   *
   * `supplierOrderId` is the SUPPLIER's id, not a board order id: the whole
   * point is orders that exist in the ERP and have no card here yet.
   */
  attachOrderToProject(supplierOrderId: string, projectId: string | null): Promise<Result<void>>;
}
