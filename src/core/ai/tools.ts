// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  buildCustomerQuote,
  quoteForOrder,
  sendCustomerQuote,
  updateCustomerQuote,
} from '../actions/customer-quote';
import { createOrder, createProject, moveOrderToStage, updateOrder } from '../actions/orders';
import { payInvoices, quotePayment } from '../actions/payments';
import { addCatalogItem, addSpecialItem, removeItem, updateItemQty } from '../actions/scope';
import { getContext } from '../boot';
import { supplierName } from '../config/runtime';
import { totalOnHand } from '../domain/catalog';
import { ORDER_STAGES } from '../domain/project';
import { formatCents } from '../lib/money';
import { type Result, err, ok } from '../lib/result';
import { buildArSummary, buildInvoiceRows } from '../selectors/ar';
import { buildBoardCards, groupByStage } from '../selectors/board';
import { searchProducts } from '../selectors/order';
import {
  catalogStore,
  invoicesStore,
  ordersStore,
  paymentMethodsStore,
  projectsStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
} from '../stores/root';
import { listOf } from '../stores/store';

/**
 * The assistant's tools.
 *
 * Every mutating tool calls the SAME action function the UI buttons call. That
 * is the load-bearing decision of this whole layer: the assistant cannot reach
 * a code path the contractor can't, cannot bypass a stage guard, and cannot
 * invent a price. If an action refuses, the model gets the refusal sentence
 * verbatim and can correct itself — which is why actions return Result rather
 * than throwing.
 */

/**
 * How much trust an action needs before it runs.
 *
 * `read`   — no side effects; runs silently.
 * `write`  — changes the contractor's own draft; runs and is reported.
 * `commit` — reaches the supplier or moves money. ALWAYS asks first, because
 *            the contractor should never learn after the fact that a purchase
 *            was placed or an invoice paid on their behalf.
 */
export type ToolTier = 'read' | 'write' | 'commit';

export interface ToolDef {
  name: string;
  description: string;
  tier: ToolTier;
  /** JSON Schema. `type` is always 'object' — the API requires it. */
  input_schema: {
    type: 'object';
    // biome-ignore lint/suspicious/noExplicitAny: JSON Schema is untyped by nature
    properties: Record<string, any>;
    required?: string[];
  };
  /** Human-readable confirmation prompt. Required for `commit` tools. */
  confirm?: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>) => Result<unknown>;
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}
function num(input: Record<string, unknown>, key: string, fallback = 0): number {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Explicit methodId wins; otherwise the account's default method. */
function resolveMethodId(input: Record<string, unknown>): string | undefined {
  const explicit = str(input, 'methodId');
  if (explicit) return explicit;
  return listOf(paymentMethodsStore.get()).find((method) => method.isDefault)?.id;
}

function orderLabel(orderId: string): string {
  const order = ordersStore.get().byId[orderId];
  if (!order) return orderId;
  const project = projectsStore.get().byId[order.projectId];
  return project ? `${order.name} (${project.name})` : order.name;
}

export const TOOLS: ToolDef[] = [
  // ---- Reads ---------------------------------------------------------------
  {
    name: 'get_board',
    description:
      'List every order on the procurement board with its stage, project, total, ' +
      'and any warnings. Call this first when the contractor asks what needs attention, ' +
      'what is outstanding, or refers to an order without naming its id.',
    tier: 'read',
    input_schema: { type: 'object', properties: {} },
    run: () => {
      const now = getContext().clock.nowIso();
      const cards = buildBoardCards(
        ordersStore.get(),
        projectsStore.get(),
        scopeStore.get(),
        quotesStore.get(),
        salesOrdersStore.get(),
        now,
      );
      return ok(
        groupByStage(cards).map((column) => ({
          stage: column.stage,
          total: formatCents(column.total),
          orders: column.cards.map((card) => ({
            orderId: card.order.id,
            project: card.project.name,
            name: card.order.name,
            total: formatCents(card.totals.subtotal),
            items: card.totals.itemCount,
            requestedDate: card.order.requestedDate ?? null,
            awaitingDealerPrice: card.totals.awaitingQuoteCount,
            supplierStatus: card.supplierStatus ?? null,
            canMoveTo: card.allowedTargets,
          })),
        })),
      );
    },
  },
  {
    name: 'get_order',
    description:
      "Read one order's full scope: every line with quantity, the contractor's price, " +
      'lead time, and whether it still needs dealer pricing.',
    tier: 'read',
    input_schema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
    run: (input) => {
      const orderId = str(input, 'orderId');
      const order = ordersStore.get().byId[orderId];
      if (!order) return err(`No order with id ${orderId}. Call get_board to list them.`);

      const items = listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
      return ok({
        orderId,
        name: order.name,
        stage: order.stage,
        fulfillment: order.fulfillment,
        requestedDate: order.requestedDate ?? null,
        lines: items.map((item) => ({
          itemId: item.id,
          name: item.snapshot.name,
          sku: item.snapshot.sku,
          qty: item.qty,
          uom: item.uom,
          unitPrice: item.unitPrice === undefined ? null : formatCents(item.unitPrice),
          priceSource: item.priceSource,
          leadTimeDays: item.snapshot.leadTimeDays ?? null,
        })),
      });
    },
  },
  {
    name: 'search_catalog',
    description:
      "Search the supplier's catalog. Returns the contractor's account price, stock, " +
      'and lead time. Use before adding anything, and to answer product questions.',
    tier: 'read',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product name, keyword, or SKU' },
      },
      required: ['query'],
    },
    run: (input) => {
      const products = searchProducts(catalogStore.get().products, str(input, 'query'), 12);
      return ok(
        products.map((product) => ({
          productId: product.id,
          sku: product.sku,
          name: product.name,
          listPrice: formatCents(product.listPrice),
          uom: product.baseUom,
          onHand: totalOnHand(product),
          leadTimeDays: product.leadTimeDays,
          presentation: product.presentation,
          specs: product.specs,
        })),
      );
    },
  },
  {
    name: 'get_open_invoices',
    description: 'List outstanding invoices with aging, and the total owed.',
    tier: 'read',
    input_schema: { type: 'object', properties: {} },
    run: () => {
      const now = getContext().clock.nowIso();
      const summary = buildArSummary(invoicesStore.get(), now);
      const rows = buildInvoiceRows(
        invoicesStore.get(),
        ordersStore.get(),
        projectsStore.get(),
        now,
      );
      return ok({
        outstanding: formatCents(summary.outstanding),
        overdue: formatCents(summary.overdue),
        invoices: rows.map((row) => ({
          invoiceId: row.invoice.id,
          number: row.invoice.number,
          forWhat: row.label,
          balance: formatCents(row.invoice.balance),
          dueAt: row.invoice.dueAt,
          daysOverdue: row.daysOverdue,
        })),
      });
    },
  },

  // ---- Writes (the contractor's own draft) ---------------------------------
  {
    name: 'create_project',
    description: 'Start a new project (a job site). Orders live inside a project.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        clientName: { type: 'string', description: "The contractor's own customer" },
        city: { type: 'string' },
      },
      required: ['name'],
    },
    run: (input) =>
      createProject({
        name: str(input, 'name'),
        ...(str(input, 'clientName') ? { clientName: str(input, 'clientName') } : {}),
        ...(str(input, 'city') ? { city: str(input, 'city') } : {}),
      }),
  },
  {
    name: 'create_order',
    description:
      'Create an order inside a project — a package of materials with one delivery ' +
      'date and one fulfillment method. This is what appears on the board.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        name: { type: 'string', description: 'e.g. "Framing package"' },
        fulfillment: { type: 'string', enum: ['delivery', 'willcall'] },
      },
      required: ['projectId', 'name'],
    },
    run: (input) => {
      const fulfillment = str(input, 'fulfillment');
      return createOrder({
        projectId: str(input, 'projectId'),
        name: str(input, 'name'),
        ...(fulfillment === 'willcall' || fulfillment === 'delivery' ? { fulfillment } : {}),
      });
    },
  },
  {
    name: 'add_materials',
    description:
      'Add a catalog product to an order. Use the productId or SKU from search_catalog. ' +
      'Adding a product already on the order increases its quantity instead of duplicating it.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        product: { type: 'string', description: 'productId or SKU' },
        qty: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['orderId', 'product', 'qty'],
    },
    run: (input) =>
      addCatalogItem({
        orderId: str(input, 'orderId'),
        product: str(input, 'product'),
        qty: num(input, 'qty', 1),
        addedBy: 'assistant',
        ...(str(input, 'notes') ? { notes: str(input, 'notes') } : {}),
      }),
  },
  {
    name: 'add_special_order_item',
    description:
      "Add something the supplier doesn't stock — a custom door, an odd trim profile. " +
      'It goes on unpriced and forces the order through the quote desk. Never invent a price.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        description: { type: 'string', description: 'Enough detail for the dealer to price it' },
        qty: { type: 'number' },
      },
      required: ['orderId', 'description', 'qty'],
    },
    run: (input) =>
      addSpecialItem({
        orderId: str(input, 'orderId'),
        description: str(input, 'description'),
        qty: num(input, 'qty', 1),
        addedBy: 'assistant',
      }),
  },
  {
    name: 'update_quantity',
    description:
      'Change a line quantity. Re-asks the ERP for a price, because volume breaks make ' +
      'price quantity-dependent.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string' }, qty: { type: 'number' } },
      required: ['itemId', 'qty'],
    },
    run: (input) => updateItemQty(str(input, 'itemId'), num(input, 'qty', 1)),
  },
  {
    name: 'remove_line',
    description: 'Remove a line from an order.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string' } },
      required: ['itemId'],
    },
    run: (input) => removeItem(str(input, 'itemId')),
  },
  {
    name: 'set_order_details',
    description: 'Set the requested delivery/pickup date, fulfillment method, or PO number.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        requestedDate: { type: 'string', description: 'ISO 8601' },
        fulfillment: { type: 'string', enum: ['delivery', 'willcall'] },
        poNumber: { type: 'string' },
      },
      required: ['orderId'],
    },
    run: (input) => {
      const fulfillment = str(input, 'fulfillment');
      return updateOrder(str(input, 'orderId'), {
        ...(str(input, 'requestedDate') ? { requestedDate: str(input, 'requestedDate') } : {}),
        ...(fulfillment === 'willcall' || fulfillment === 'delivery' ? { fulfillment } : {}),
        ...(str(input, 'poNumber') ? { poNumber: str(input, 'poNumber') } : {}),
      });
    },
  },
  {
    name: 'build_customer_quote',
    description:
      "Build a contractor-branded proposal for the contractor's own customer, with markup. " +
      'This creates a draft — it does not send anything.',
    tier: 'write',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        markupPercent: { type: 'number' },
      },
      required: ['orderId'],
    },
    run: (input) => {
      const built = buildCustomerQuote(str(input, 'orderId'));
      if (!built.ok) return built;
      const markup = num(input, 'markupPercent', -1);
      if (markup >= 0) updateCustomerQuote(built.value.id, { markupPercent: markup });
      return ok({ quoteId: built.value.id, number: built.value.number });
    },
  },

  // ---- Commits (reach the supplier or move money) ---------------------------
  {
    name: 'move_order_stage',
    description:
      'Move an order between board stages. Plan→Quote sends it to the supplier quote ' +
      "desk; Plan/Quote→Order places a real sales order. Invoice is the supplier's move and " +
      'cannot be set here. If the move is refused, tell the contractor the reason verbatim.',
    tier: 'commit',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        stage: { type: 'string', enum: [...ORDER_STAGES] },
      },
      required: ['orderId', 'stage'],
    },
    confirm: (input) => {
      const stage = str(input, 'stage');
      const label = orderLabel(str(input, 'orderId'));
      if (stage === 'quote') return `Send ${label} to the ${supplierName()} quote desk?`;
      if (stage === 'order') return `Place ${label} as a real order with ${supplierName()}?`;
      return `Move ${label} back to ${stage}?`;
    },
    run: (input) => {
      const stage = str(input, 'stage');
      if (!ORDER_STAGES.includes(stage as (typeof ORDER_STAGES)[number])) {
        return err(`"${stage}" is not a stage. Use one of: ${ORDER_STAGES.join(', ')}.`);
      }
      return moveOrderToStage(str(input, 'orderId'), stage as (typeof ORDER_STAGES)[number]);
    },
  },
  {
    name: 'send_customer_quote',
    description:
      "Send the customer quote to the contractor's customer. This freezes the proposal and " +
      'mints a share link. Re-sending kills the previous link.',
    tier: 'commit',
    input_schema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
    confirm: (input) => {
      const quote = quoteForOrder(str(input, 'orderId'));
      return `Send ${quote?.number ?? 'the quote'} to ${quote?.customer.name || 'your customer'}?`;
    },
    run: (input) => {
      const quote = quoteForOrder(str(input, 'orderId'));
      if (!quote) return err('Build a customer quote for this order first.');
      return sendCustomerQuote(quote.id);
    },
  },
  {
    name: 'pay_invoices',
    description: 'Pay one or more open invoices with a saved payment method.',
    tier: 'commit',
    input_schema: {
      type: 'object',
      properties: {
        invoiceIds: { type: 'array', items: { type: 'string' } },
        methodId: { type: 'string', description: 'Omit to use the default method' },
      },
      required: ['invoiceIds'],
    },
    confirm: (input) => {
      // The prompt must name the amount that will actually be charged — fee
      // included — so it is built from the same quotePayment the action charges
      // through. Summing raw balances here once approved "$14,000" while a card
      // default charged $14,406.
      const ids = [
        ...new Set(Array.isArray(input.invoiceIds) ? (input.invoiceIds as string[]) : []),
      ];
      const methodId = resolveMethodId(input);
      const quoted = methodId ? quotePayment(ids, methodId) : null;
      if (!quoted?.ok) {
        return `Pay ${ids.length} invoice${ids.length === 1 ? '' : 's'}? (The exact amount could not be computed — decline this and check the Pay screen.)`;
      }
      const { subtotal, fee, total, method } = quoted.value;
      const feeNote = fee > 0 ? ` (${formatCents(subtotal)} + ${formatCents(fee)} card fee)` : '';
      return `Pay ${formatCents(total)}${feeNote} across ${ids.length} invoice${
        ids.length === 1 ? '' : 's'
      } with ${method.label}?`;
    },
    run: (input) => {
      const ids = Array.isArray(input.invoiceIds) ? (input.invoiceIds as string[]) : [];
      const methodId = resolveMethodId(input);
      if (!methodId) return err('No saved payment method.');
      return payInvoices({ invoiceIds: ids, methodId });
    },
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** The Anthropic tool-definition shape — `tier`/`confirm`/`run` stay client-side. */
export function toolSchemas() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}
