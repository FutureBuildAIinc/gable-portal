// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type {
  Brand,
  Category,
  Location,
  PriceQuote,
  Product,
  Uom,
  VolumeBreak,
} from '../domain/catalog';
import type { SalesOrder, SalesOrderStatus, TrackingEvent } from '../domain/supplier';
import type { EntityId } from '../lib/ids';
import { type Cents, toCents } from '../lib/money';
import type { IsoDateTime } from '../lib/time';
import type { CatalogState } from '../stores/root';
import type {
  GableCatalogProduct,
  GableCategoryNode,
  GableDelivery,
  GableOrder,
  GableVolumeBreak,
} from './schema';

/**
 * The one file where `gable`'s vocabulary becomes the portal's.
 *
 * Everything crossing this boundary changes units (float dollars -> integer
 * cents), naming (snake_case -> camelCase) and, in two places, meaning. The
 * meaning changes are the ones worth reading:
 *
 *  - **Lead time is nullable and the null is load-bearing.** `gable` sends
 *    `lead_time_days: null` when the dealer has not published one and `0` when
 *    the product ships today. This file keeps them apart: null becomes an
 *    ABSENT `leadTimeDays`, and the portal's lead-time-vs-delivery-date
 *    warnings stay silent on absence rather than computing against a guess.
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
 * A node of the ERP's real category tree, keyed by its own id rather than by
 * its display name.
 *
 * Two categories in a dealer's tree can legitimately share a name under
 * different parents ("Accessories" under Decking and under Roofing), and
 * `categoryIdFor` would collapse them into one aisle. The tree has ids, so it
 * uses them; `categoryIdFor` remains only for products the ERP left
 * unlinked, where a name is genuinely all there is.
 */
export function categoryIdForNode(gableCategoryId: string): EntityId {
  return `${CATEGORY_PREFIX}${gableCategoryId}`;
}

/**
 * The portal's category id for a product: its tree link when the ERP linked
 * it, and the slugged display name when it did not.
 *
 * Both branches must agree with what `catalogStateFrom` puts in the category
 * list, or a product lands in an aisle that does not exist and disappears from
 * browse without any signal that it is missing.
 */
export function categoryIdForProduct(dto: GableCatalogProduct): EntityId {
  return dto.category_id ? categoryIdForNode(dto.category_id) : categoryIdFor(dto.category);
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
    categoryId: categoryIdForProduct(dto),
    brandId: GABLE_BRAND_ID,
    ...(dto.image_url ? { imageUrl: dto.image_url } : {}),
    baseUom: uomFrom(dto.uom),
    isActive: true,
    listPrice: toCents(dto.base_price),
    tags: [dto.category, dto.species, dto.grade].filter((tag) => tag !== ''),
    relatedSkus: [],
    specs,
    /**
     * The dealer's published lead time, or nothing at all.
     *
     * `lead_time_days: 0` means "ships today" and is kept as 0. `null` means
     * the dealer has not published one and is kept ABSENT — not folded into 0,
     * which would publish "available today" for every product a dealer has
     * never entered a lead time for, and not replaced with a plausible guess,
     * which is worse still because a crew gets booked around it.
     */
    ...(typeof dto.lead_time_days === 'number' ? { leadTimeDays: dto.lead_time_days } : {}),
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
 * The ERP's category forest, flattened into the portal's parent-pointer shape.
 *
 * `selectors/catalog.ts` walks `parentId` to cascade a browse selection down a
 * subtree, so the tree arrives as a flat list with parents rather than as
 * nested nodes. `gable` already guards against cycles and orphans when it
 * builds the forest, so this is a straight walk.
 */
export function categoriesFromTree(nodes: readonly GableCategoryNode[]): Category[] {
  const out: Category[] = [];

  const walk = (node: GableCategoryNode, parentId: EntityId | undefined): void => {
    out.push({
      id: categoryIdForNode(node.id),
      name: node.name,
      slug: node.slug,
      ...(parentId ? { parentId } : {}),
    });
    for (const child of node.children ?? []) walk(child, categoryIdForNode(node.id));
  };

  for (const node of nodes) walk(node, undefined);
  return out;
}

/**
 * The whole catalog store, derived from `GET /catalog` and `GET
 * /catalog/categories`.
 *
 * The tree is the dealer's own `product_categories` hierarchy, so browse
 * cascades exactly the way `?category_id=` would on the server: clicking
 * "Lumber" shows the studs filed under Framing Lumber two levels down.
 *
 * A product the ERP has NOT linked to the tree still has to be browsable, so
 * its flat `category` display string is synthesised into a parentless aisle
 * exactly as before. Those synthesised aisles are appended AFTER the real
 * ones, and only when a product actually needs them — an empty invented
 * category would be a shape the dealer never configured.
 */
export function catalogStateFrom(
  dtos: readonly GableCatalogProduct[],
  dealerName: string,
  tree: readonly GableCategoryNode[] = [],
): CatalogState {
  const categories = new Map<EntityId, Category>();
  for (const category of categoriesFromTree(tree)) categories.set(category.id, category);

  for (const dto of dtos) {
    // Linked to the real tree: nothing to synthesise. If the id is somehow not
    // in the tree — an inactive category the catalog still points at — fall
    // through and give it an aisle, or its products vanish from browse.
    if (dto.category_id && categories.has(categoryIdForNode(dto.category_id))) continue;

    const id = categoryIdForProduct(dto);
    if (categories.has(id)) continue;
    const name = dto.category.trim() || 'Uncategorised';
    categories.set(id, { id, name, slug: id.slice(CATEGORY_PREFIX.length) });
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

/** One rung of the ERP's ladder, in the portal's units. */
export function volumeBreakFrom(dto: GableVolumeBreak): VolumeBreak {
  return { minQty: dto.min_quantity, unitPrice: toCents(dto.unit_price) };
}

/**
 * The next rung above `qty` that is genuinely cheaper per unit.
 *
 * Both conditions matter. A rung at or below the current quantity is not an
 * opportunity — it is already being applied. A rung that is not cheaper is not
 * one either, and `gable` can legitimately return one: the ladder is projected
 * from the real waterfall, and a contract price can beat a volume rule at
 * every quantity. Showing "buy 40 more to pay the same" is worse than showing
 * nothing.
 */
export function nextBreakAbove(
  breaks: readonly VolumeBreak[],
  qty: number,
  unitPrice: Cents,
): VolumeBreak | undefined {
  return [...breaks]
    .sort((a, b) => a.minQty - b.minQty)
    .find((rung) => rung.minQty > qty && rung.unitPrice < unitPrice);
}

/**
 * The contractor's price, straight from the ERP's own waterfall.
 *
 * This is the swap `sim/pricing.ts` was written anticipating: same `PriceQuote`
 * out, no tier table, no discount rules, no contract SKUs on this side of the
 * counter.
 *
 * `breaks` is the ladder `gable` computed for THIS customer, and it is passed
 * in rather than read here because it arrives from a different endpoint
 * (`GET /catalog/{id}/volume-breaks`) than the price. Omit it and `nextBreak`
 * stays absent — the field is optional precisely so a caller that has not
 * loaded a ladder shows nothing rather than a break that does not exist.
 */
export function priceQuoteFrom(
  dto: GableCatalogProduct,
  qty: number,
  breaks?: readonly VolumeBreak[],
): PriceQuote {
  const unitPrice = toCents(dto.customer_price);
  const next = breaks ? nextBreakAbove(breaks, qty, unitPrice) : undefined;
  return {
    sku: dto.sku,
    unitPrice,
    listPrice: toCents(dto.base_price),
    qty,
    ...(next ? { nextBreak: next } : {}),
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
