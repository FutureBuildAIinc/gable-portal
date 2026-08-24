// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import {
  GABLE_BRAND_ID,
  GABLE_LOCATION_ID,
  catalogStateFrom,
  categoryIdFor,
  isUnmappedErpStatus,
  priceQuoteFrom,
  productFrom,
  refineWithDelivery,
  salesOrderFrom,
  salesOrderIdFor,
  salesOrderStatusFrom,
  uomFrom,
} from '../mapper';
import type { GableCatalogProduct, GableDelivery, GableOrder } from '../schema';

/**
 * The units boundary, and the honesty boundary.
 *
 * `gable` speaks float dollars and a five-state order vocabulary; the portal
 * speaks integer cents and an eight-state supplier flow. Both conversions can
 * be wrong in ways nothing downstream would catch — a half-cent lost in a
 * float multiply, or a `picking` state invented for an ERP that has no such
 * concept and a card that then claims a forklift is moving.
 *
 * The fixtures are real values captured from a running `gable` against the
 * seeded `gable_db`, not numbers chosen to make the arithmetic tidy.
 */

const CORN2006: GableCatalogProduct = {
  id: '8bb239c5-269b-4c57-bf8c-ddc4f168127b',
  sku: 'CORN2006',
  name: 'Flashing J 6 X 6 X 10',
  category: 'Cornice',
  species: '',
  grade: '',
  image_url: '',
  uom: 'EA',
  base_price: 23.25,
  customer_price: 23.24,
  price_source: 'PROMOTIONAL',
  available: 871,
  in_stock: true,
};

const LUMBER: GableCatalogProduct = {
  ...CORN2006,
  id: '161d4948-652f-4eb4-b8de-fc22d8ec57f2',
  sku: 'LUM-248-PREM',
  name: '2x4x8 SPF Premium',
  category: 'Dimensional Lumber',
  species: 'SPF',
  grade: 'Premium',
  uom: 'EA',
  base_price: 5.5,
  customer_price: 4.95,
  price_source: 'CONTRACT',
  available: 0,
  in_stock: false,
};

describe('money crosses the boundary as integer cents', () => {
  it('converts dollars without losing a half cent', () => {
    // 23.25 * 100 in binary float is 2324.9999999999995. `toCents` scales via
    // the decimal string, so this is 2325 and not 2324.
    expect(productFrom(CORN2006).listPrice).toBe(2325);
    expect(priceQuoteFrom(CORN2006, 1).unitPrice).toBe(2324);
  });

  it('puts base_price on listPrice, so a discount reads as a discount', () => {
    const quote = priceQuoteFrom(LUMBER, 40);

    expect(quote.listPrice).toBe(550);
    expect(quote.unitPrice).toBe(495);
    // Putting customer_price in both fields would render "0% off" on every
    // product in a portal whose whole premise is account pricing.
    expect(quote.listPrice).toBeGreaterThan(quote.unitPrice);
  });

  it('never publishes a volume break, because gable does not send one', () => {
    // Absent, not zero. A break the ERP did not grant is money a contractor
    // would chase and not get.
    expect(priceQuoteFrom(LUMBER, 500).nextBreak).toBeUndefined();
  });

  it('carries the quantity through even though gable prices per unit', () => {
    expect(priceQuoteFrom(LUMBER, 40).qty).toBe(40);
  });
});

describe('product mapping invents nothing', () => {
  it('reports no lead time, because the ERP publishes none', () => {
    // `gable`'s catalog has no lead-time column. Guessing "7 days" would put a
    // crew on site for a delivery nobody promised.
    expect(productFrom(LUMBER).leadTimeDays).toBe(0);
  });

  it('leaves the description empty rather than generating product copy', () => {
    expect(productFrom(LUMBER).description).toBe('');
  });

  it('files everything as commodity, the half that shows a price and no story', () => {
    expect(productFrom(LUMBER).presentation).toBe('commodity');
  });

  it('carries availability into stock so the UI can say out of stock', () => {
    expect(productFrom(CORN2006).stock).toEqual([
      { locationId: GABLE_LOCATION_ID, onHand: 871, onOrder: 0 },
    ]);
    expect(productFrom(LUMBER).stock[0]?.onHand).toBe(0);
  });

  it('turns species and grade into specs, and drops the blanks', () => {
    expect(productFrom(LUMBER).specs).toEqual([
      { label: 'Species', value: 'SPF' },
      { label: 'Grade', value: 'Premium' },
    ]);
    expect(productFrom(CORN2006).specs).toEqual([]);
  });

  it('falls back to EA for a UOM outside the portal’s closed union', () => {
    expect(uomFrom('sht')).toBe('SHT');
    expect(uomFrom('BUNDLE')).toBe('BD');
    expect(uomFrom('PALLET')).toBe('EA');
  });
});

describe('catalog state', () => {
  it('derives one flat category per distinct name and does not invent a tree', () => {
    const state = catalogStateFrom(
      [CORN2006, LUMBER, { ...LUMBER, id: 'x', sku: 'LUM-2' }],
      'Kelly-Fradet',
    );

    expect(state.categories.map((category) => category.name)).toEqual([
      'Cornice',
      'Dimensional Lumber',
    ]);
    // Parentless: `gable` publishes no hierarchy, so fabricating one would give
    // browse a shape the dealer never configured.
    expect(state.categories.every((category) => category.parentId === undefined)).toBe(true);
    expect(state.products).toHaveLength(3);
  });

  it('names the single brand and location after the dealer, not after a fixture', () => {
    const state = catalogStateFrom([CORN2006], 'Kelly-Fradet');

    expect(state.brands).toEqual([
      { id: GABLE_BRAND_ID, name: 'Kelly-Fradet', description: expect.any(String) },
    ]);
    expect(state.locations[0]?.name).toBe('Kelly-Fradet');
  });

  it('gives the same category the same id every time', () => {
    expect(categoryIdFor('Dimensional Lumber')).toBe(categoryIdFor('  dimensional lumber  '));
  });
});

describe('order status is lossy in the safe direction only', () => {
  it.each([
    ['DRAFT', 'submitted'],
    ['CONFIRMED', 'confirmed'],
    ['FULFILLED', 'delivered'],
    ['CANCELLED', 'cancelled'],
  ] as const)('maps %s to %s', (erp, portal) => {
    expect(salesOrderStatusFrom(erp)).toBe(portal);
  });

  it('never invents picking, ready-willcall, or out-for-delivery from an order', () => {
    // `gable`'s order header has no such states. The only place a truck is
    // known to be moving is the deliveries resource.
    const produced = ['DRAFT', 'CONFIRMED', 'FULFILLED', 'CANCELLED', 'ON_HOLD'].map(
      salesOrderStatusFrom,
    );

    expect(produced).not.toContain('picking');
    expect(produced).not.toContain('ready-willcall');
    expect(produced).not.toContain('out-for-delivery');
  });

  it('rounds ON_HOLD down to the last thing known to be true, and flags it', () => {
    expect(salesOrderStatusFrom('ON_HOLD')).toBe('confirmed');
    expect(isUnmappedErpStatus('ON_HOLD')).toBe(true);
    expect(isUnmappedErpStatus('CONFIRMED')).toBe(false);
  });
});

describe('a delivery refines the order status, and only forwards', () => {
  const delivery = (status: string): GableDelivery => ({
    id: 'd1',
    order_id: 'o1',
    status,
    created_at: '2026-08-21T12:57:09Z',
  });

  it('promotes a confirmed order whose truck has left', () => {
    expect(refineWithDelivery('confirmed', delivery('OUT_FOR_DELIVERY'))).toBe('out-for-delivery');
  });

  it('does not walk a delivered order backwards on a stale PENDING row', () => {
    expect(refineWithDelivery('delivered', delivery('PENDING'))).toBe('delivered');
    expect(refineWithDelivery('delivered', delivery('OUT_FOR_DELIVERY'))).toBe('delivered');
  });

  it('leaves a cancelled order alone', () => {
    expect(refineWithDelivery('cancelled', delivery('OUT_FOR_DELIVERY'))).toBe('cancelled');
  });

  it('has no state for PARTIAL or FAILED, so it does not guess one', () => {
    expect(refineWithDelivery('confirmed', delivery('PARTIAL'))).toBe('confirmed');
    expect(refineWithDelivery('confirmed', delivery('FAILED'))).toBe('confirmed');
  });
});

describe('the supplier record built from an ERP order', () => {
  const dto: GableOrder = {
    id: '00c1b91d-b406-467b-8336-d75e59c0a5b1',
    status: 'CONFIRMED',
    total_amount: 1866,
    created_at: '2026-08-18T17:00:00-07:00',
    lines: [],
  };

  it('derives a stable id so polling patches instead of duplicating', () => {
    expect(salesOrderIdFor(dto.id)).toBe(`gso_${dto.id}`);
  });

  it('quotes the ERP’s own word in the note, under the dealer’s name', () => {
    const salesOrder = salesOrderFrom({
      orderId: 'ord_1',
      salesOrderId: salesOrderIdFor(dto.id),
      dto,
      fulfillment: 'delivery',
      observedAt: '2026-08-24T17:00:00Z',
      dealerName: 'Kelly-Fradet',
    });

    expect(salesOrder.status).toBe('confirmed');
    expect(salesOrder.subtotal).toBe(186_600);
    expect(salesOrder.tracking).toHaveLength(1);
    expect(salesOrder.tracking[0]?.note).toBe('Kelly-Fradet reports this order as CONFIRMED.');
  });

  it('shows a short form of the ERP id rather than minting a fake order number', () => {
    const salesOrder = salesOrderFrom({
      orderId: 'ord_1',
      salesOrderId: salesOrderIdFor(dto.id),
      dto,
      fulfillment: 'delivery',
      observedAt: '2026-08-24T17:00:00Z',
      dealerName: 'Kelly-Fradet',
    });

    // A minted "SO-5001" is a number nobody at the dealer could look up.
    expect(salesOrder.number).toBe('GBL-00c1b91d');
  });

  it('says out loud when it had to round the ERP’s status off', () => {
    const salesOrder = salesOrderFrom({
      orderId: 'ord_1',
      salesOrderId: salesOrderIdFor(dto.id),
      dto: { ...dto, status: 'ON_HOLD' },
      fulfillment: 'delivery',
      observedAt: '2026-08-24T17:00:00Z',
      dealerName: 'Kelly-Fradet',
    });

    expect(salesOrder.tracking[0]?.note).toContain('ON_HOLD');
    expect(salesOrder.tracking[0]?.note).toContain('confirmed');
  });
});
