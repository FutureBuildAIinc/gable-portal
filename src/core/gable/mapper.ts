// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Brand, Category, Location, PriceQuote, Product, Uom } from '../domain/catalog';
import type { SalesOrder, SalesOrderStatus, TrackingEvent } from '../domain/supplier';
import type { EntityId } from '../lib/ids';
import { type Cents, toCents } from '../lib/money';
import type { IsoDateTime } from '../lib/time';
import type { CatalogState } from '../stores/root';
import type { GableCatalogProduct, GableDelivery, GableOrder } from './schema';

/**
 * The one file where `gable`'s vocabulary becomes the portal's.
 *
 * Everything crossing this boundary changes units (float dollars -> integer
 * cents), naming (snake_case -> camelCase) and, in two places, meaning. The
 * meaning changes are the ones worth reading:
 *
 *  - `gable` has no lead-time field on a catalog product, and no volume breaks
 *    on the portal catalog endpoint. Those are not defaulted to a plausible
 *    number; they are absent, and the UI has to render absence.
 *  - `gable`'s order status vocabulary (DRAFT/CONFIRMED/FULFILLED/CANCELLED/
 *    ON_HOLD) is coarser than the portal's eight-state supplier flow. Mapping
 *    is lossy in one direction only — see `salesOrderStatusFrom`.
 *
 * The rule this file exists to enforce: nothing here may invent a value the
 * ERP did not send. A fabricated lead time is worse than a missing one,
 * because a contractor schedules a crew around it.
 */

/** Namespaced so an ERP-derived id can never be confused with a seeded one. */
export const GABLE_LOCATION_ID = 'gloc_erp';
export const GABLE_BRAND_ID = 'gbrand_dealer';
const CATEGORY_PREFIX = 'gcat_';

/** `gable` sends a display name; the portal keys categories by id. */
export function categoryIdFor(name: string): EntityId {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${CATEGORY_PREFIX}${slug || 'uncategorised'}`;
}

/**
 * `gable` stores UOM as free text. Anything outside the portal's closed union
 * falls back to `EA` — a wrong-but-countable unit beats a type error, and the
 * SKU name carries the real unit in every seeded case.
 */
const UOM_BY_CODE: Record<string, Uom> = {
  EA: 'EA',
  EACH: 'EA',
  LF: 'LF',
  BF: 'BF',
  SQ: 'SQ',
  SHT: 'SHT',
  SHEET: 'SHT',
  BD: 'BD',
  BDL: 'BD',
  BUNDLE: 'BD',
  BG: 'BG',
  BAG: 'BG',
  BX: 'BX',
  BOX: 'BX',
  RL: 'RL',
  ROLL: 'RL',
  CY: 'CY',
};

export function uomFrom(code: string): Uom {
  return UOM_BY_CODE[code.trim().toUpperCase()] ?? 'EA';
}

/**
 * One ERP product -> one portal product.
 *
 * `listPrice` is `base_price`, NOT `customer_price`: list is what the saving is
 * measured against, and putting the contractor's own price in both fields makes
 * every product read "0% off" — which is the sort of quietly wrong number this
 * repository has been correcting.
 */
export function productFrom(dto: GableCatalogProduct): Product {
  const specs = [
    ...(dto.species ? [{ label: 'Species', value: dto.species }] : []),
    ...(dto.grade ? [{ label: 'Grade', value: dto.grade }] : []),
  ];

  return {
    id: dto.id,
    sku: dto.sku,
    name: dto.name,
    // The ERP's catalog carries no description. An empty string is honest; a
    // generated sentence would read as product copy the dealer never wrote.
    description: '',
    categoryId: categoryIdFor(dto.category),
    brandId: GABLE_BRAND_ID,
    ...(dto.image_url ? { imageUrl: dto.image_url } : {}),
    baseUom: uomFrom(dto.uom),
    isActive: true,
    listPrice: toCents(dto.base_price),
    tags: [dto.category, dto.species, dto.grade].filter((tag) => tag !== ''),
    relatedSkus: [],
    specs,
    /**
     * `gable`'s portal catalog exposes availability but NOT a lead time, so
     * every ERP-sourced product is 0 — "we are not telling you a wait". The
     * portal's lead-time-vs-delivery-date warnings therefore go quiet on the
     * wired path. That is a gap in the ERP contract, recorded in ROADMAP §1,
     * not something to paper over with an invented number of days.
     */
    leadTimeDays: 0,
    stock: [{ locationId: GABLE_LOCATION_ID, onHand: dto.available, onOrder: 0 }],
    /**
     * `presentation` decides whether a product earns a narrative on a customer
     * quote. The ERP has no equivalent concept, so everything lands as
     * `commodity` — the conservative half, which shows a real price and no
     * invented story.
     */
    presentation: 'commodity',
  };
}

/**
 * The whole catalog store, derived from one `GET /catalog` response.
 *
 * Categories are synthesised from the distinct category names the ERP returned,
 * flat and parentless. `gable` has no category tree on the portal surface, and
 * fabricating a hierarchy would give the browse UI a shape the dealer never
 * configured.
 */
export function catalogStateFrom(
  dtos: readonly GableCatalogProduct[],
  dealerName: string,
): CatalogState {
  const categories = new Map<EntityId, Category>();
  for (const dto of dtos) {
    const name = dto.category.trim() || 'Uncategorised';
    const id = categoryIdFor(name);
    if (!categories.has(id)) {
      categories.set(id, { id, name, slug: id.slice(CATEGORY_PREFIX.length) });
    }
  }

  const brand: Brand = {
    id: GABLE_BRAND_ID,
    name: dealerName,
    description: 'Supplied by your dealer. Brand detail is not exposed by the ERP catalog.',
  };

  const location: Location = { id: GABLE_LOCATION_ID, name: dealerName, kind: 'yard' };

  return {
    products: dtos.map(productFrom),
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    brands: [brand],
    locations: [location],
  };
}

/**
 * The contractor's price, straight from the ERP's own waterfall.
 *
 * This is the swap `sim/pricing.ts` was written anticipating: same `PriceQuote`
 * out, no tier table, no discount rules, no contract SKUs on this side of the
 * counter. `nextBreak` is absent because `gable`'s portal catalog does not
 * publish volume breaks — the field is optional precisely so a source without
 * them stays honest instead of showing a break that does not exist.
 */
export function priceQuoteFrom(dto: GableCatalogProduct, qty: number): PriceQuote {
  return {
    sku: dto.sku,
    unitPrice: toCents(dto.customer_price),
    listPrice: toCents(dto.base_price),
    qty,
  };
}

/**
 * `gable` order status -> portal supplier status.
 *
 * Lossy, and deliberately lossy in the safe direction. The ERP has five states
 * where the portal flow has eight; `picking`, `ready-willcall` and
 * `out-for-delivery` have no order-level equivalent at all. Rather than guess a
 * progression, an unmapped status lands on the nearest state that is certainly
 * true and the raw ERP value is carried into the tracking note, so what the
 * contractor reads is "Confirmed — Gable says ON_HOLD" and never a fabricated
 * "Being picked".
 *
 * `out-for-delivery` and `delivered` are reachable, but only from the
 * DELIVERIES resource — see `refineWithDelivery`.
 */
export function salesOrderStatusFrom(erpStatus: string): SalesOrderStatus {
  switch (erpStatus.trim().toUpperCase()) {
    case 'DRAFT':
      return 'submitted';
    case 'CONFIRMED':
      return 'confirmed';
    case 'FULFILLED':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    case 'ON_HOLD':
      // The order exists and was acknowledged; it is not moving. `confirmed` is
      // the last thing we know to be true, and the hold is stated in the note.
      return 'confirmed';
    default:
      return 'submitted';
  }
}

/** True when `gable` sent a status this portal has no state for. */
export function isUnmappedErpStatus(erpStatus: string): boolean {
  const upper = erpStatus.trim().toUpperCase();
  return (
    upper !== 'DRAFT' && upper !== 'CONFIRMED' && upper !== 'FULFILLED' && upper !== 'CANCELLED'
  );
}

/**
 * A delivery, when one exists, is more specific than the order header — it is
 * the only place `gable` says a truck is moving. Applied on top of the order
 * status rather than instead of it, and only ever forwards: a PENDING delivery
 * against a FULFILLED order must not walk the card backwards.
 */
export function refineWithDelivery(
  status: SalesOrderStatus,
  delivery: GableDelivery | undefined,
): SalesOrderStatus {
  if (!delivery || status === 'cancelled') return status;
  switch (delivery.status.trim().toUpperCase()) {
    case 'OUT_FOR_DELIVERY':
      return status === 'delivered' ? status : 'out-for-delivery';
    case 'DELIVERED':
      return 'delivered';
    // PARTIAL and FAILED both mean "not delivered, a human is involved". The
    // portal has no state for either, so the order status stands and the
    // delivery's own record carries the detail.
    default:
      return status;
  }
}

export function totalCentsFrom(dto: GableOrder): Cents {
  return toCents(dto.total_amount);
}

/**
 * Build the portal's supplier-side record from what the ERP returned.
 *
 * `tracking` holds exactly one event — what `gable` says right now, and when we
 * asked. The portal's simulator writes a rich event history because it invented
 * the history; `gable` does not expose an order status log on the portal
 * surface, so inventing one here would be dressing a single data point as an
 * audit trail.
 */
export interface SalesOrderFromGableInput {
  /** The portal-side board order this ERP order belongs to. */
  orderId: EntityId;
  /** Stable portal id derived from the ERP order id, so refresh is idempotent. */
  salesOrderId: EntityId;
  dto: GableOrder;
  delivery?: GableDelivery | undefined;
  fulfillment: SalesOrder['fulfillment'];
  observedAt: IsoDateTime;
  /**
   * The dealer's own name, as the ERP reports it in `PortalConfig`.
   *
   * Passed in rather than hardcoded because a white-label deployment for
   * Kelly-Fradet must not tell its contractors that "Gable reports this order
   * as CONFIRMED" — the supplier's name is configuration everywhere in this
   * codebase, and a tracking note is contractor-facing copy like any other.
   */
  dealerName: string;
}

export function salesOrderFrom(input: SalesOrderFromGableInput): SalesOrder {
  const base = salesOrderStatusFrom(input.dto.status);
  const status = refineWithDelivery(base, input.delivery);
  const raw = input.dto.status.trim().toUpperCase();

  // The raw ERP word is always quoted, so a contractor comparing the portal
  // with a phone call to the yard sees the same vocabulary. When the portal had
  // to round the status off, say so in the same breath rather than let the
  // rounded state stand alone.
  const note = isUnmappedErpStatus(raw)
    ? `${input.dealerName} reports this order as ${raw}, which this portal shows as "${status}".`
    : `${input.dealerName} reports this order as ${raw}.`;

  const event: TrackingEvent = { at: input.observedAt, status, note };

  const promised = input.delivery?.scheduled_date ?? undefined;

  return {
    id: input.salesOrderId,
    orderId: input.orderId,
    // `gable` has no human order number on the portal surface — the id is all
    // there is, so the portal shows a short form of it rather than minting a
    // fake SO-5001 that no one at the dealer could look up.
    number: `GBL-${input.dto.id.slice(0, 8)}`,
    status,
    fulfillment: input.fulfillment,
    submittedAt: input.dto.created_at,
    ...(promised ? { promisedDate: promised } : {}),
    ...(status === 'delivered' && input.delivery?.pod_timestamp
      ? { deliveredAt: input.delivery.pod_timestamp }
      : {}),
    subtotal: totalCentsFrom(input.dto),
    tracking: [event],
  };
}

/** Deterministic, so polling the same ERP order twice patches instead of duplicating. */
export function salesOrderIdFor(gableOrderId: string): EntityId {
  return `gso_${gableOrderId}`;
}
