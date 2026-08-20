// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  AGING_BUCKETS,
  type AgingBucket,
  agingBucket,
  daysPastDue,
  isOverdue,
} from '../domain/payment';
import type { Order, Project } from '../domain/project';
import type { Invoice } from '../domain/supplier';
import type { EntityId } from '../lib/ids';
import type { Cents } from '../lib/money';
import type { IsoDateTime } from '../lib/time';
import { type Collection, listOf } from '../stores/store';

/**
 * Read models for accounts receivable. Pure functions over store snapshots, so
 * the same shapes feed the Pay screen today and the AI's read tools later.
 *
 * The thing a contractor actually needs from an AR screen is not a ledger — it
 * is an answer to "what is late, and what job was it for". An invoice number
 * tells them nothing; "Wilson Custom Home" tells them everything. Every shape
 * here exists to carry that answer to the surface.
 */

export interface AgingSlice {
  bucket: AgingBucket;
  total: Cents;
  count: number;
}

export interface ArSummary {
  outstanding: Cents;
  /** Everything past its due date — the number that decides whether to act today. */
  overdue: Cents;
  openCount: number;
  overdueCount: number;
  /** Always all four buckets, in AGING_BUCKETS order. */
  buckets: AgingSlice[];
}

function openInvoices(invoices: Collection<Invoice>): Invoice[] {
  return listOf(invoices).filter((invoice) => invoice.balance > 0);
}

export function buildArSummary(invoices: Collection<Invoice>, now: IsoDateTime): ArSummary {
  const open = openInvoices(invoices);

  // Seeded with every bucket at zero. An empty "60+" column is information —
  // it says nothing is that late — and a bar whose columns appear and vanish
  // as balances age is unreadable.
  const slices = new Map<AgingBucket, AgingSlice>(
    AGING_BUCKETS.map((bucket) => [bucket, { bucket, total: 0, count: 0 }]),
  );

  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;

  for (const invoice of open) {
    outstanding += invoice.balance;

    const slice = slices.get(agingBucket(invoice.dueAt, now));
    if (slice) {
      slice.total += invoice.balance;
      slice.count += 1;
    }

    if (isOverdue(invoice.dueAt, now)) {
      overdue += invoice.balance;
      overdueCount += 1;
    }
  }

  return {
    outstanding,
    overdue,
    openCount: open.length,
    overdueCount,
    buckets: AGING_BUCKETS.map((bucket) => slices.get(bucket) ?? { bucket, total: 0, count: 0 }),
  };
}

export interface InvoiceRow {
  invoice: Invoice;
  bucket: AgingBucket;
  /** 0 when the invoice is not yet due. */
  daysOverdue: number;
  overdue: boolean;
  /** What this bill was for, in the words the contractor uses for the work. */
  label: string;
  /** Present only when the invoice traces back to a live order — drives the drill-down. */
  orderId?: EntityId;
}

/**
 * The job this invoice belongs to.
 *
 * A counter sale has no order to trace, which is exactly why it gets named as
 * one: a contractor who sees an unexplained balance assumes a billing error.
 */
function labelFor(
  invoice: Invoice,
  orders: Collection<Order>,
  projects: Collection<Project>,
): string {
  const order = invoice.orderId ? orders.byId[invoice.orderId] : undefined;
  const project = order ? projects.byId[order.projectId] : undefined;
  if (project) return project.name;
  if (order) return order.name;
  if (invoice.origin === 'counter') return 'In-store purchase';
  return invoice.description;
}

/** Only the order id that still resolves — a dangling one would render a dead link. */
function liveOrderId(invoice: Invoice, orders: Collection<Order>): EntityId | undefined {
  return invoice.orderId && orders.byId[invoice.orderId] ? invoice.orderId : undefined;
}

/**
 * Every open invoice, most overdue first.
 *
 * Sorting by lateness rather than by date issued puts the money that is costing
 * the relationship at the top of the screen, which is the only ordering that
 * matches why someone opened this page.
 */
export function buildInvoiceRows(
  invoices: Collection<Invoice>,
  orders: Collection<Order>,
  projects: Collection<Project>,
  now: IsoDateTime,
): InvoiceRow[] {
  return openInvoices(invoices)
    .map((invoice) => {
      const orderId = liveOrderId(invoice, orders);
      return {
        invoice,
        bucket: agingBucket(invoice.dueAt, now),
        daysOverdue: daysPastDue(invoice.dueAt, now),
        overdue: isOverdue(invoice.dueAt, now),
        label: labelFor(invoice, orders, projects),
        ...(orderId ? { orderId } : {}),
      } satisfies InvoiceRow;
    })
    .sort(
      (a, b) =>
        b.daysOverdue - a.daysOverdue ||
        a.invoice.dueAt.localeCompare(b.invoice.dueAt) ||
        a.invoice.number.localeCompare(b.invoice.number),
    );
}

export interface PaidInvoiceRow {
  invoice: Invoice;
  label: string;
  orderId?: EntityId;
}

/**
 * Settled invoices, most recent first. Kept out of the open list because
 * history is reassurance, not work — but a contractor who just paid needs to
 * see the payment land somewhere.
 */
export function buildPaidInvoiceRows(
  invoices: Collection<Invoice>,
  orders: Collection<Order>,
  projects: Collection<Project>,
): PaidInvoiceRow[] {
  return listOf(invoices)
    .filter((invoice) => invoice.balance === 0)
    .map((invoice) => {
      const orderId = liveOrderId(invoice, orders);
      return {
        invoice,
        label: labelFor(invoice, orders, projects),
        ...(orderId ? { orderId } : {}),
      } satisfies PaidInvoiceRow;
    })
    .sort((a, b) => b.invoice.issuedAt.localeCompare(a.invoice.issuedAt));
}

/** Total of the rows the contractor has ticked. */
export function selectedTotal(
  rows: readonly InvoiceRow[],
  selectedIds: ReadonlySet<string>,
): Cents {
  let total = 0;
  for (const row of rows) {
    if (selectedIds.has(row.invoice.id)) total += row.invoice.balance;
  }
  return total;
}
