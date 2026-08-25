// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Product, Uom } from '../domain/catalog';
import type { Order, Project, ScopeItem } from '../domain/project';
import type { SalesOrder } from '../domain/supplier';
import { toCents } from '../lib/money';
import type { IsoDateTime } from '../lib/time';
import type { GableClient } from './client';
import { salesOrderFrom, salesOrderIdFor, uomFrom } from './mapper';
import type { GableOrder } from './schema';

/**
 * The customer's EXISTING order history at the dealer, landed on the board.
 *
 * This could not be done before. `PortalOrderDTO` carried no project, so an
 * order placed at the counter or over the phone had nowhere to go on a
 * project-scoped board, and importing it would have meant inventing a job for
 * it — rewriting the contractor's own project structure to make a list fit.
 * The portal therefore showed only what it had placed itself, and a contractor
 * looking at the Wilson house saw a fraction of what they had actually bought
 * for it.
 *
 * `project_id` on the order, and `GET /orders?project_id=`, are what make it
 * possible: the dealer already knows which job each order was for, so the
 * portal asks per job and puts each order exactly where the DEALER filed it.
 *
 * ## Why the query is per project rather than one list filtered here
 *
 * The scoping is the ERP's. `gable` verifies that the project belongs to the
 * calling customer and answers 404 for anyone else's, so a project id that is
 * not this contractor's cannot return rows. Pulling the whole list and
 * grouping locally would move that check into a browser, which is the one
 * place it means nothing.
 *
 * ## What is deliberately NOT inferred
 *
 *  - **Stage.** Every imported order lands in `order` — "the supplier has it",
 *    which is true of all of them. It does NOT land in `invoice`, because the
 *    portal's Invoice stage means a portal-side invoice record exists and the
 *    order feed carries none. The real state is on the sales order, where the
 *    ERP's own word for it is quoted.
 *  - **A name.** `gable` publishes no human order number or title on the portal
 *    surface, so the card is titled with the same short form of the id the
 *    tracking screen uses. Minting "Framing package" would be writing the
 *    contractor's words for them.
 *  - **A list price.** The order line carries what was charged and nothing
 *    else, so there is no saving to show and none is shown.
 */

/** Deterministic, so re-connecting adopts the same card rather than a second one. */
export function boardOrderIdFor(gableOrderId: string): string {
  return `gord_${gableOrderId}`;
}

/** True for a board order this module created, rather than one the contractor did. */
export function isImportedOrder(orderId: string): boolean {
  return orderId.startsWith('gord_');
}

export interface AdoptedHistory {
  orders: Order[];
  items: ScopeItem[];
  salesOrders: SalesOrder[];
  /**
   * ERP orders that belong to NO project.
   *
   * Not imported, and not dropped either: they are real purchases on the
   * contractor's account with nowhere to land yet. A consumer shows them and
   * offers to file them, which is what `PUT /orders/{id}/project` is for.
   */
  unassigned: GableOrder[];
}

export interface AdoptHistoryInput {
  client: GableClient;
  projects: readonly Project[];
  /** The ERP catalog, for the unit of measure an order line does not carry. */
  products: readonly Product[];
  dealerName: string;
  now: IsoDateTime;
}

function uomForProduct(products: readonly Product[], productId: string): Uom {
  return products.find((product) => product.id === productId)?.baseUom ?? uomFrom('EA');
}

function scopeItemsFor(
  dto: GableOrder,
  boardOrderId: string,
  products: readonly Product[],
): ScopeItem[] {
  return (dto.lines ?? []).map((line, index) => ({
    id: `gsi_${dto.id}_${index}`,
    orderId: boardOrderId,
    kind: 'catalog' as const,
    productId: line.product_id,
    snapshot: { sku: line.product_sku, name: line.product_name },
    qty: line.quantity,
    // The order line has no unit of measure — `PortalLineDTO` carries a
    // quantity and a price and nothing about how it is measured. The catalog
    // knows, so the catalog is asked; a product no longer in the catalog falls
    // back to `EA`, which is wrong-but-countable rather than a type error.
    uom: uomForProduct(products, line.product_id),
    unitPrice: toCents(line.price_each),
    // What the dealer charged, resolved by their own waterfall.
    priceSource: 'erp' as const,
    addedBy: 'user' as const,
    addedAt: dto.created_at,
    sortOrder: index,
  }));
}

export interface BoardCard {
  order: Order;
  items: ScopeItem[];
  salesOrder: SalesOrder;
}

/** One ERP order as a board card on a named job. */
export function boardCardFrom(input: {
  dto: GableOrder;
  projectId: string;
  products: readonly Product[];
  dealerName: string;
  now: IsoDateTime;
  sortOrder: number;
}): BoardCard {
  const { dto } = input;
  const boardOrderId = boardOrderIdFor(dto.id);

  return {
    order: {
      id: boardOrderId,
      projectId: input.projectId,
      name: `GBL-${dto.id.slice(0, 8)}`,
      stage: 'order',
      // The order DTO says nothing about delivery vs pickup. `delivery` is
      // the portal's default everywhere and the tracking screen corrects it
      // from the deliveries resource, which is the only thing that knows.
      fulfillment: 'delivery',
      salesOrderId: salesOrderIdFor(dto.id),
      createdAt: dto.created_at,
      updatedAt: dto.updated_at ?? dto.created_at,
      sortOrder: input.sortOrder,
    },
    items: scopeItemsFor(dto, boardOrderId, input.products),
    salesOrder: salesOrderFrom({
      orderId: boardOrderId,
      salesOrderId: salesOrderIdFor(dto.id),
      dto,
      fulfillment: 'delivery',
      observedAt: input.now,
      dealerName: input.dealerName,
    }),
  };
}

/**
 * Pull each job's dealer-side order history and turn it into board cards.
 *
 * A failure on one project is swallowed and that job is simply left without
 * its history: a single unreadable project must not stop a contractor
 * connecting at all.
 */
export async function adoptOrderHistory(input: AdoptHistoryInput): Promise<AdoptedHistory> {
  const orders: Order[] = [];
  const items: ScopeItem[] = [];
  const salesOrders: SalesOrder[] = [];
  const claimed = new Set<string>();

  for (const project of input.projects) {
    let page: GableOrder[];
    try {
      const feed = await input.client.orderFeed({ projectId: project.id });
      page = feed.orders ?? [];
    } catch {
      continue;
    }

    page.forEach((dto, index) => {
      if (claimed.has(dto.id)) return;
      claimed.add(dto.id);

      const card = boardCardFrom({
        dto,
        projectId: project.id,
        products: input.products,
        dealerName: input.dealerName,
        now: input.now,
        sortOrder: index,
      });
      orders.push(card.order);
      items.push(...card.items);
      salesOrders.push(card.salesOrder);
    });
  }

  // One more read, unscoped, to find what belongs to no job. It is a separate
  // call rather than a filter over the per-project pages because "has no
  // project" is not expressible as a project_id.
  let unassigned: GableOrder[] = [];
  try {
    const all = await input.client.orders();
    unassigned = all.filter((dto) => !dto.project_id);
  } catch {
    unassigned = [];
  }

  return { orders, items, salesOrders, unassigned };
}
