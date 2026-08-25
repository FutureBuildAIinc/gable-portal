// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { supplierName } from '../config/runtime';
import type { Product } from '../domain/catalog';
import type { Order, OrderStage, Project, ScopeItem } from '../domain/project';
import { itemExtended } from '../domain/project';
import type { Invoice, SalesOrder } from '../domain/supplier';
import { type IsoDateTime, addDays } from '../lib/time';
import type { PricingEngine, PricingInput } from '../sim/pricing';
import { ACCOUNT_ID, TIER_PRO_ID } from './account-seed';

/**
 * The showcase demo state.
 *
 * Built to exercise every board rule rather than to look tidy:
 *  - a clean, fully-priced order that can go straight Plan -> Order
 *  - an order carrying a special-order line, so the quote-desk gate fires
 *  - an order missing a delivery date, so that guard fires
 *  - one project (Wilson) with orders sitting in three different stages at
 *    once, which is the whole reason board cards are orders and not projects
 *  - an empty order, so the "add materials first" guard has something to hit
 */

export interface ScenarioData {
  projects: Project[];
  orders: Order[];
  items: ScopeItem[];
  invoices: Invoice[];
  salesOrders: SalesOrder[];
}

interface Ctx {
  products: Product[];
  pricing: PricingEngine;
  now: IsoDateTime;
}

const ACCOUNT: PricingInput = { accountId: ACCOUNT_ID, tierId: TIER_PRO_ID };

const SO_WILSON_FRAME = 'so_wilson_frame';
const SO_WILSON_ROOF = 'so_wilson_roof';
const SO_KIRKLAND = 'so_kirkland';

export function buildScenario(ctx: Ctx): ScenarioData {
  const bySku = new Map(ctx.products.map((product) => [product.sku, product]));
  const projects: Project[] = [];
  const orders: Order[] = [];
  const items: ScopeItem[] = [];

  let itemSeq = 0;

  function project(
    id: string,
    name: string,
    clientName: string,
    city: string,
    createdDaysAgo: number,
  ): Project {
    const record: Project = {
      id,
      accountId: ACCOUNT_ID,
      name,
      clientName,
      address: {
        id: `addr_${id}`,
        line1: '—',
        city,
        state: 'SD',
        zip: '57104',
      },
      createdAt: addDays(ctx.now, -createdDaysAgo),
      updatedAt: addDays(ctx.now, -Math.floor(createdDaysAgo / 2)),
    };
    projects.push(record);
    return record;
  }

  function order(
    id: string,
    projectId: string,
    name: string,
    stage: OrderStage,
    opts: {
      fulfillment?: Order['fulfillment'];
      inDays?: number | null;
      sortOrder?: number;
      poNumber?: string;
    } = {},
  ): Order {
    const inDays = opts.inDays === undefined ? 10 : opts.inDays;
    const record: Order = {
      id,
      projectId,
      name,
      stage,
      fulfillment: opts.fulfillment ?? 'delivery',
      ...(inDays !== null ? { requestedDate: addDays(ctx.now, inDays) } : {}),
      deliveryAddressId: `addr_${projectId}`,
      ...(opts.poNumber ? { poNumber: opts.poNumber } : {}),
      createdAt: addDays(ctx.now, -14),
      updatedAt: addDays(ctx.now, -2),
      sortOrder: opts.sortOrder ?? orders.filter((o) => o.stage === stage).length,
    };
    orders.push(record);
    return record;
  }

  /** A catalog line, priced by the ERP exactly as the live app would price it. */
  function line(orderId: string, sku: string, qty: number, notes?: string): void {
    const product = bySku.get(sku);
    if (!product) return;
    const quote = ctx.pricing.quote(product, qty, ACCOUNT);
    items.push({
      id: `si_${++itemSeq}`,
      orderId,
      kind: 'catalog',
      productId: product.id,
      snapshot: {
        sku: product.sku,
        name: product.name,
        ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
        ...(product.leadTimeDays !== undefined ? { leadTimeDays: product.leadTimeDays } : {}),
      },
      qty,
      uom: product.baseUom,
      ...(notes ? { notes } : {}),
      unitPrice: quote.unitPrice,
      listPrice: quote.listPrice,
      priceSource: 'erp',
      addedBy: 'user',
      addedAt: addDays(ctx.now, -5),
      sortOrder: items.filter((i) => i.orderId === orderId).length,
    });
  }

  /** A line the ERP cannot price — the reason the quote desk exists. */
  function special(orderId: string, sku: string, name: string, qty: number): void {
    items.push({
      id: `si_${++itemSeq}`,
      orderId,
      kind: 'special',
      snapshot: { sku, name },
      qty,
      uom: 'EA',
      priceSource: 'unpriced',
      addedBy: 'user',
      addedAt: addDays(ctx.now, -3),
      sortOrder: items.filter((i) => i.orderId === orderId).length,
    });
  }

  // --- Miller Residence: the "ready to buy" story --------------------------
  const miller = project('prj_miller', 'Miller Residence — Deck', 'Dana Miller', 'Sioux Falls', 21);

  const millerFraming = order('ord_miller_frame', miller.id, 'Deck framing & footings', 'plan', {
    inDays: 9,
    sortOrder: 0,
  });
  line(millerFraming.id, 'PT-6X6-8', 6, 'Support posts — cut to height');
  line(millerFraming.id, 'PT-2X6-12', 24);
  line(millerFraming.id, 'PT-2X6-8', 10);
  line(millerFraming.id, 'CONC-RMX-80', 12);

  // Special-order line: blocks the direct route, forces the quote desk.
  const millerDeck = order('ord_miller_deck', miller.id, 'Decking & rail', 'plan', {
    inDays: 16,
    sortOrder: 1,
  });
  line(millerDeck.id, 'DECK-EVRD-CLM-12', 42);
  special(millerDeck.id, 'SO-EVRD-PEBBLE', 'EverDeck Signature rail kit — Pebble Grey', 3);

  // --- Anderson: sitting at the quote desk ---------------------------------
  const anderson = project('prj_anderson', 'Anderson Pole Barn', 'Ray Anderson', 'Milbank', 30);
  const andersonPkg = order('ord_anderson', anderson.id, 'Post frame package', 'quote', {
    inDays: 24,
    sortOrder: 0,
  });
  line(andersonPkg.id, 'PT-6X6-8', 18);
  line(andersonPkg.id, 'LBR-2X6-12-DF', 64);
  line(andersonPkg.id, 'PLY-OSB-7/16-4X8', 48);
  special(andersonPkg.id, 'SO-DOOR-1416', 'Overhead door 14x16 — insulated', 1);

  // --- Wilson: one project, three stages at once ---------------------------
  const wilson = project('prj_wilson', 'Wilson Custom Home', 'Priya Wilson', 'Sioux Falls', 62);

  const wilsonFrame = order('ord_wilson_frame', wilson.id, 'Framing package', 'order', {
    inDays: 2,
    sortOrder: 0,
    poNumber: 'PO-4471',
  });
  line(wilsonFrame.id, 'LBR-2X6-8-DF', 180);
  line(wilsonFrame.id, 'LBR-2X4-8-DF', 240);
  line(wilsonFrame.id, 'PLY-CDX-1/2-4X8', 64);

  const wilsonRoof = order('ord_wilson_roof', wilson.id, 'Roof package', 'order', {
    inDays: 6,
    sortOrder: 1,
    poNumber: 'PO-4488',
  });
  line(wilsonRoof.id, 'RF-ARCH-PEWTER', 34);
  line(wilsonRoof.id, 'RF-FELT-15', 8);

  // Still being planned while the rest of the job is already moving.
  const wilsonTrim = order('ord_wilson_trim', wilson.id, 'Interior trim', 'plan', {
    inDays: 34,
    sortOrder: 2,
  });
  line(wilsonTrim.id, 'INS-R19-KF-15', 22);

  // --- Kirkland: billed, awaiting payment ----------------------------------
  const kirkland = project('prj_kirkland', 'Cedar Fence — Kirkland', 'Tom Kirkland', 'Veblen', 75);
  const kirklandFence = order('ord_kirkland', kirkland.id, 'Fence materials', 'invoice', {
    inDays: -12,
    fulfillment: 'willcall',
    sortOrder: 0,
    poNumber: 'PO-4310',
  });
  line(kirklandFence.id, 'PT-4X4-8', 26);
  line(kirklandFence.id, 'LBR-2X4-8-DF', 96);

  // --- An empty draft: the "add materials first" guard needs a target ------
  order('ord_miller_pergola', miller.id, 'Pergola (rough idea)', 'plan', {
    inDays: null,
    sortOrder: 2,
  });

  /**
   * Sales orders for the cards already sitting past Plan.
   *
   * Without these, an order in the Order column has nothing to track and no
   * supplier status — the same incoherence as an Invoice-stage card with no
   * invoice. Only the simulator creates these at runtime, so the seed has to
   * supply them for orders it starts mid-flight.
   */
  function seedSalesOrder(
    id: string,
    orderRecord: Order,
    number: string,
    status: SalesOrder['status'],
    daysAgo: number,
    history: [SalesOrder['status'], string, number][],
  ): SalesOrder {
    const subtotal = items
      .filter((item) => item.orderId === orderRecord.id)
      .reduce((sum, item) => sum + itemExtended(item), 0);

    return {
      id,
      orderId: orderRecord.id,
      number,
      status,
      fulfillment: orderRecord.fulfillment,
      submittedAt: addDays(ctx.now, -daysAgo),
      ...(orderRecord.requestedDate ? { promisedDate: orderRecord.requestedDate } : {}),
      ...(status === 'delivered' || status === 'invoiced'
        ? { deliveredAt: addDays(ctx.now, -Math.max(1, daysAgo - 5)) }
        : {}),
      subtotal,
      tracking: history.map(([trackStatus, note, offset]) => ({
        at: addDays(ctx.now, -offset),
        status: trackStatus,
        note,
      })),
    };
  }

  const salesOrders: SalesOrder[] = [
    seedSalesOrder(SO_WILSON_FRAME, wilsonFrame, 'SO-5087', 'out-for-delivery', 6, [
      ['submitted', `Order received by ${supplierName()}.`, 6],
      ['confirmed', `Order confirmed by ${supplierName()}.`, 6],
      ['picking', 'Pulled from the Main Yard.', 4],
      ['out-for-delivery', 'Loaded on truck 12.', 1],
    ]),
    seedSalesOrder(SO_WILSON_ROOF, wilsonRoof, 'SO-5091', 'confirmed', 3, [
      ['submitted', `Order received by ${supplierName()}.`, 3],
      ['confirmed', `Order confirmed by ${supplierName()}.`, 3],
    ]),
    seedSalesOrder(SO_KIRKLAND, kirklandFence, 'SO-5044', 'invoiced', 40, [
      ['submitted', `Order received by ${supplierName()}.`, 40],
      ['confirmed', `Order confirmed by ${supplierName()}.`, 40],
      ['picking', 'Staged on the dock.', 39],
      ['ready-willcall', 'Ready at the Main Yard will-call counter.', 39],
      ['delivered', 'Collected from will-call.', 38],
      ['invoiced', 'Invoiced as INV-8874.', 38],
    ]),
  ];

  // Link each order to its sales order, the way the simulator would.
  for (const salesOrder of salesOrders) {
    const target = orders.find((candidate) => candidate.id === salesOrder.orderId);
    if (target) target.salesOrderId = salesOrder.id;
  }

  /**
   * Open AR.
   *
   * The Kirkland order sits in the Invoice column, so it needs a real invoice
   * behind it — a card in Invoice with nothing to pay reads as a bug. The
   * counter sale is the other half of the story this product tells: material
   * bought at the trade desk lands in the same AR bucket as everything ordered
   * through the portal, which is the whole point of it being all-in-one.
   */
  const kirklandTotal = items
    .filter((item) => item.orderId === kirklandFence.id)
    .reduce((sum, item) => sum + itemExtended(item), 0);

  const invoices: Invoice[] = [
    {
      id: 'inv_kirkland',
      number: 'INV-8874',
      accountId: ACCOUNT_ID,
      orderId: kirklandFence.id,
      salesOrderId: SO_KIRKLAND,
      origin: 'portal',
      issuedAt: addDays(ctx.now, -38),
      dueAt: addDays(ctx.now, -8),
      subtotal: kirklandTotal,
      balance: kirklandTotal,
      description: 'Fence materials — Cedar Fence, Kirkland',
    },
    {
      id: 'inv_counter',
      number: 'INV-8902',
      accountId: ACCOUNT_ID,
      origin: 'counter',
      issuedAt: addDays(ctx.now, -12),
      dueAt: addDays(ctx.now, 18),
      subtotal: 47_431,
      balance: 47_431,
      description: 'Counter sale — Main Yard, 7/18',
    },
  ];

  return { projects, orders, items, invoices, salesOrders };
}
