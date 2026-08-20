// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';
import type { Cents } from '../lib/money';

/**
 * The product catalog as the contractor sees it.
 *
 * Note what is NOT here: no pricing tiers, no discount rules, no contract
 * tables. Those live inside the supplier's ERP (modelled in src/core/sim).
 * The contractor sees a resolved `PriceQuote` and nothing about how it was
 * computed — which is exactly how a real dealer portal behaves, and means a
 * real ERP can replace the sim without touching the domain.
 */

export type Uom =
  | 'EA' // each
  | 'LF' // linear foot
  | 'BF' // board foot
  | 'SQ' // roofing square (100 sq ft)
  | 'SHT' // sheet
  | 'BD' // bundle
  | 'BG' // bag
  | 'BX' // box
  | 'RL' // roll
  | 'CY'; // cubic yard

export interface Brand {
  id: EntityId;
  name: string;
  description?: string;
  logoUrl?: string;
  website?: string;
}

export interface Category {
  id: EntityId;
  name: string;
  slug: string;
  parentId?: EntityId;
}

/** A location that holds inventory. Drives will-call vs delivery and stock questions. */
export interface Location {
  id: EntityId;
  name: string;
  kind: 'yard' | 'warehouse';
}

export interface StockLevel {
  locationId: EntityId;
  onHand: number;
  onOrder: number;
}

export interface SpecPair {
  label: string;
  value: string;
}

export interface Product {
  id: EntityId;
  sku: string;
  name: string;
  description: string;
  categoryId: EntityId;
  brandId: EntityId;
  imageUrl?: string;
  baseUom: Uom;
  isActive: boolean;

  /** Public list price. The contractor's actual price comes from the ERP. */
  listPrice: Cents;
  msrp?: Cents;

  tags: string[];
  relatedSkus: string[];
  specs: SpecPair[];

  /**
   * Days until available if not on hand. 0 means stocked.
   * Drives the lead-time-vs-delivery-date warnings that are core to the product.
   */
  leadTimeDays: number;
  stock: StockLevel[];

  /** Used by takeoff math: how much one unit covers. */
  coverageSqFt?: number;
  coverageLf?: number;

  /**
   * Groups interchangeable products for value engineering ("show me a cheaper
   * composite decking"). Two products sharing a specClass are substitutable.
   */
  specClass?: string;

  /**
   * Whether a homeowner would recognise this as something they chose.
   *
   * Decking, doors, siding, fixtures — visible finishes — are `selection`, and
   * earn a product narrative on a customer quote. Studs, fasteners, and
   * sheathing are `commodity`: real cost, no story, and giving them hero
   * imagery would bury the decisions that actually matter.
   */
  presentation: Presentation;
}

export type Presentation = 'selection' | 'commodity';

export function totalOnHand(product: Product): number {
  return product.stock.reduce((sum, level) => sum + level.onHand, 0);
}

export function isStocked(product: Product): boolean {
  return totalOnHand(product) > 0;
}

/**
 * What the ERP answers when asked "what does THIS contractor pay for this?"
 *
 * `unitPrice` is the only number the contractor is promised. `listPrice` is
 * carried alongside purely so the UI can show the saving, and `nextBreak` is
 * the one piece of pricing mechanics worth surfacing — buying more drops the
 * unit price, and a contractor who can't see that is leaving money behind.
 */
export interface PriceQuote {
  sku: string;
  unitPrice: Cents;
  listPrice: Cents;
  /** Quantity this quote was computed for — breaks make price qty-dependent. */
  qty: number;
  nextBreak?: VolumeBreak;
}

export interface VolumeBreak {
  /** Buy at least this many to get `unitPrice`. */
  minQty: number;
  unitPrice: Cents;
}

export function savingsPerUnit(quote: PriceQuote): Cents {
  return Math.max(0, quote.listPrice - quote.unitPrice);
}

export function discountPercent(quote: PriceQuote): number {
  if (quote.listPrice <= 0) return 0;
  return Math.round(((quote.listPrice - quote.unitPrice) / quote.listPrice) * 100);
}
