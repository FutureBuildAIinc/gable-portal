// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';
import { type Cents, multiplyCents } from '../lib/money';
import type { IsoDateTime } from '../lib/time';
import type { Uom } from './catalog';

/**
 * The two-level model behind the Procurement Board.
 *
 *   Project  "Wilson Custom Home"   — the site. Address, customer, the thing
 *                                     the contractor talks about. Has no stage.
 *     Order  "Framing package"      — a procurement unit. THIS is the board
 *     Order  "Roofing"                card. One delivery date, one fulfillment
 *     Order  "Trim"                   method, its own stage.
 *
 * Orders are what move Plan -> Quote -> Order -> Invoice, so every card has
 * exactly one unambiguous stage. The Project view is the drill-down that shows
 * a job's orders sitting across different stages at once.
 */

export type OrderStage = 'plan' | 'quote' | 'order' | 'invoice';

export const ORDER_STAGES: readonly OrderStage[] = ['plan', 'quote', 'order', 'invoice'] as const;

export const STAGE_LABELS: Record<OrderStage, string> = {
  plan: 'Plan',
  quote: 'Quote',
  order: 'Order',
  invoice: 'Invoice',
};

export type Fulfillment = 'delivery' | 'willcall';

export interface Address {
  id: EntityId;
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export interface Project {
  id: EntityId;
  accountId: EntityId;
  name: string;
  /** The contractor's own client — the homeowner a customer quote is sent to. */
  clientName?: string;
  address?: Address;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  archivedAt?: IsoDateTime;
}

/**
 * A procurement order: the board card, and the unit that gets priced,
 * quoted, ordered, and invoiced.
 *
 * It is an Order at every stage of its life — the stage tells you how real it
 * is. In `plan` it is a prospective order the contractor is still shaping; by
 * `order` an ERP sales order exists and `salesOrderId` is set.
 */
export interface Order {
  id: EntityId;
  projectId: EntityId;
  name: string;
  stage: OrderStage;

  fulfillment: Fulfillment;
  /** When the contractor wants it on site (or ready for pickup). */
  requestedDate?: IsoDateTime;
  deliveryAddressId?: EntityId;
  siteInstructions?: string;
  poNumber?: string;

  /** Set once the corresponding artifact exists on the supplier side. */
  quoteId?: EntityId;
  salesOrderId?: EntityId;
  invoiceId?: EntityId;

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Position within its board column. */
  sortOrder: number;
}

/**
 * How a line got its price. Drives what the UI can promise: a `quoted` line is
 * a firm number from the dealer's quote desk, an `estimate` is the contractor's
 * own placeholder on a special-order item and must not be shown to a customer
 * as final.
 */
export type PriceSource = 'erp' | 'quoted' | 'estimate' | 'unpriced';

export type { Presentation } from './catalog';

/**
 * A line on an order.
 *
 * `catalog` lines reference a real product. `special` lines are things the
 * dealer doesn't stock or can't auto-price — a custom door, an odd trim
 * profile. Special lines are the reason the quote desk exists: they cannot be
 * priced by the ERP, so an order containing one cannot skip straight to Order.
 */
export interface ScopeItem {
  id: EntityId;
  orderId: EntityId;
  kind: 'catalog' | 'special';

  productId?: EntityId;
  /**
   * Frozen copy of the product at the moment it was added. Deliberate: a quote
   * already sent to a homeowner must not silently change because the dealer
   * edited the catalog. The live product is still reachable via productId.
   */
  snapshot: ItemSnapshot;

  qty: number;
  uom: Uom;
  notes?: string;

  /** Resolved by the ERP for catalog lines; by the quote desk for special ones. */
  unitPrice?: Cents;
  priceSource: PriceSource;
  /** List price at time of pricing, so the UI can show the contractor's saving. */
  listPrice?: Cents;
  /**
   * When the supplier's number stops standing. Set on desk-quoted lines, because
   * lumber moves and a dealer cannot hold a price forever. An expired line is
   * treated exactly like an unpriced one — it has to go back to the desk.
   */
  priceExpiresAt?: IsoDateTime;

  addedBy: 'user' | 'assistant';
  addedAt: IsoDateTime;
  sortOrder: number;
}

export interface ItemSnapshot {
  sku: string;
  name: string;
  imageUrl?: string;
  brandName?: string;
  /** Only meaningful for catalog lines. */
  leadTimeDays?: number;
}

/** Special-order SKUs are synthesised with this prefix and read as such everywhere. */
export const SPECIAL_ORDER_PREFIX = 'SO-';

export function isSpecialOrderSku(sku: string): boolean {
  return sku.startsWith(SPECIAL_ORDER_PREFIX);
}

/** True when the supplier's number has lapsed and no longer stands. */
export function isPriceExpired(item: ScopeItem, now: IsoDateTime): boolean {
  return item.priceExpiresAt !== undefined && item.priceExpiresAt <= now;
}

export function isPriced(item: ScopeItem, now?: IsoDateTime): boolean {
  if (item.unitPrice === undefined || item.priceSource === 'unpriced') return false;
  if (now !== undefined && isPriceExpired(item, now)) return false;
  return true;
}

/**
 * Lines the ERP cannot price on its own — these force the quote-desk route.
 * A line whose quoted price has expired counts again: the dealer's number
 * lapsed, so nobody is standing behind it any more.
 */
export function needsQuoteDesk(items: readonly ScopeItem[], now?: IsoDateTime): ScopeItem[] {
  return items.filter((item) => {
    if (item.kind !== 'special') return false;
    if (item.priceSource !== 'quoted') return true;
    return now !== undefined && isPriceExpired(item, now);
  });
}

export function itemExtended(item: ScopeItem): Cents {
  if (item.unitPrice === undefined) return 0;
  return multiplyCents(item.unitPrice, item.qty);
}
