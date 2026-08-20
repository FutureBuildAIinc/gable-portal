// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { activeMember, teamMembers } from '@core/actions/team';
import { getContext } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import { AGING_LABELS, type AgingBucket } from '@core/domain/payment';
import { can } from '@core/domain/team';
import { formatCents, formatCentsCompact } from '@core/lib/money';
import { formatDate } from '@core/lib/time';
import {
  type InvoiceRow,
  buildArSummary,
  buildInvoiceRows,
  buildPaidInvoiceRows,
  selectedTotal,
} from '@core/selectors/ar';
import { invoicesStore, ordersStore, projectsStore } from '@core/stores/root';
import { teamStore } from '@core/stores/root';
import { PaymentSheet } from '@ui/components/pay/PaymentSheet';
import { useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { Check, ChevronRight, PartyPopper } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Accounts receivable, from the paying side.
 *
 * Ordered by lateness rather than by date, because the only question this
 * screen answers is "what is hurting me right now". The aging bar doubles as
 * the filter: a contractor who taps "60+" is doing triage, not reading a
 * statement, and giving them a separate filter control would be a second step
 * for the same intent.
 */

interface Props {
  onOpenOrder?: ((orderId: string) => void) | undefined;
}

/** Narrow enough for four tiles at 375px; AGING_LABELS carries the full wording. */
const SHORT_BUCKET: Record<AgingBucket, string> = {
  current: 'Current',
  '1-30': '1–30d',
  '31-60': '31–60d',
  '60+': '60+d',
};

export function PayPage({ onOpenOrder }: Props) {
  useStore(teamStore, (state) => state);
  const acting = activeMember();
  const canPay = acting ? can(acting.role, 'pay') : true;
  const invoices = useStore(invoicesStore, (state) => state);
  const orders = useStore(ordersStore, (state) => state);
  const projects = useStore(projectsStore, (state) => state);
  const now = getContext().clock.nowIso();

  const [bucket, setBucket] = useState<AgingBucket | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [payOpen, setPayOpen] = useState(false);
  /**
   * Frozen at the moment the sheet opens. Paid invoices drop straight out of
   * the open list, so a live-derived list would empty itself the instant the
   * payment lands — and take the receipt's contents with it.
   */
  const [sheetRows, setSheetRows] = useState<InvoiceRow[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const summary = useMemo(() => buildArSummary(invoices, now), [invoices, now]);
  const rows = useMemo(
    () => buildInvoiceRows(invoices, orders, projects, now),
    [invoices, orders, projects, now],
  );
  const paid = useMemo(
    () => buildPaidInvoiceRows(invoices, orders, projects).slice(0, 6),
    [invoices, orders, projects],
  );

  const visible = bucket ? rows.filter((row) => row.bucket === bucket) : rows;
  // Selection survives a filter change, so paying is never silently narrowed
  // by a tap on the aging bar.
  const paying = rows.filter((row) => selected.has(row.invoice.id));
  const payingTotal = selectedTotal(rows, selected);

  function toggle(invoiceId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(invoiceId)) next.add(invoiceId);
      return next;
    });
  }

  if (rows.length === 0 && paid.length === 0) {
    return (
      <Empty
        title="No open invoices"
        body={`Invoices appear here once ${supplierName()} delivers and bills an order.`}
      />
    );
  }

  return (
    <>
      {!canPay ? (
        <div className="border-border border-b bg-surface-inset px-4 py-2.5 lg:px-6">
          <p className="text-[12.5px] leading-snug text-text-muted">
            You can review everything here, but payments are made by{' '}
            {teamMembers()
              .filter((member) => can(member.role, 'pay'))
              .map((member) => member.name)
              .join(' or ') || 'the owner'}
            . Switch people from the header to pay.
          </p>
        </div>
      ) : null}
      <section className="border-border border-b bg-surface px-4 py-4 lg:px-6">
        <p className="text-[12.5px] text-text-muted">Outstanding balance</p>
        <p className="text-[30px] font-semibold leading-tight tracking-tight tabular-nums">
          {formatCents(summary.outstanding)}
        </p>
        <p className="mt-0.5 text-[12.5px]">
          {summary.overdue > 0 ? (
            <span style={{ color: 'var(--danger)' }}>
              {formatCents(summary.overdue)} overdue across {summary.overdueCount} invoice
              {summary.overdueCount === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="text-text-muted">
              {summary.openCount} open invoice{summary.openCount === 1 ? '' : 's'}, none overdue
            </span>
          )}
        </p>

        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {summary.buckets.map((slice) => {
            const active = bucket === slice.bucket;
            // A month late is a nudge; two months is a problem with the
            // relationship. Colouring both the same would flatten that.
            const tone =
              slice.total === 0 || slice.bucket === 'current'
                ? undefined
                : slice.bucket === '1-30'
                  ? 'var(--warning)'
                  : 'var(--danger)';
            return (
              <button
                key={slice.bucket}
                type="button"
                onClick={() => setBucket(active ? null : slice.bucket)}
                aria-pressed={active}
                aria-label={`${AGING_LABELS[slice.bucket]} — ${formatCents(slice.total)}`}
                className={cn(
                  'min-h-14 rounded-[var(--radius-card)] border px-1.5 py-2 text-center transition-colors',
                  active
                    ? 'border-brand bg-brand-tint'
                    : 'border-border bg-surface-inset hover:bg-surface-3',
                )}
              >
                <span className="block text-[10.5px] text-text-muted">
                  {SHORT_BUCKET[slice.bucket]}
                </span>
                <span
                  className="block text-[13px] font-semibold tabular-nums"
                  style={tone ? { color: tone } : undefined}
                >
                  {slice.total === 0 ? '—' : formatCentsCompact(slice.total)}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {rows.length === 0 ? (
        <Empty
          title="You're all caught up"
          body={`Nothing is owed to ${supplierName()} right now.`}
          celebrate
        />
      ) : (
        <ul className="pb-36">
          {visible.map((row) => (
            <InvoiceListRow
              key={row.invoice.id}
              row={row}
              now={now}
              checked={selected.has(row.invoice.id)}
              onToggle={toggle}
              {...(onOpenOrder ? { onOpenOrder } : {})}
            />
          ))}
          {visible.length === 0 ? (
            <li className="px-6 py-12 text-center text-sm text-text-subtle">
              Nothing in {AGING_LABELS[bucket ?? 'current']}.{' '}
              <button
                type="button"
                onClick={() => setBucket(null)}
                className="text-brand underline underline-offset-2"
              >
                Show all
              </button>
            </li>
          ) : null}
        </ul>
      )}

      {paid.length > 0 ? (
        <section className={cn('px-4 lg:px-6', rows.length === 0 ? 'pt-6 pb-36' : 'pb-36')}>
          <h2 className="mb-2 text-[12px] font-semibold text-text-muted">Recently paid</h2>
          <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface">
            {paid.map((row) => (
              <li
                key={row.invoice.id}
                className="flex items-center gap-2.5 border-border border-b px-3 py-2.5 last:border-b-0"
              >
                <Check size={15} strokeWidth={2.5} style={{ color: 'var(--success)' }} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{row.label}</span>
                <span className="text-data shrink-0 text-text-subtle">{row.invoice.number}</span>
                <span className="shrink-0 text-[12.5px] text-text-muted tabular-nums">
                  {formatCents(row.invoice.subtotal)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Sticky action bar — sits above the mobile tab bar, beside the desktop rail. */}
      {/* The bar is always there once anything is payable: an action that only
          appears after you discover a checkbox is an action most people never
          find. Unselected, it states the mechanic instead of hiding. */}
      {rows.length > 0 && canPay ? (
        <div className="fixed inset-x-0 bottom-16 z-20 border-border border-t bg-surface/95 p-3 backdrop-blur lg:bottom-0 lg:left-60">
          <button
            type="button"
            disabled={paying.length === 0}
            onClick={() => {
              setSheetRows(paying);
              setPayOpen(true);
            }}
            className={cn(
              'flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-5 font-medium transition-colors',
              paying.length === 0
                ? 'bg-surface-3 text-text-muted'
                : 'bg-brand text-brand-on hover:bg-brand-hover',
            )}
          >
            <span className="text-[15px]">
              {paying.length === 0
                ? 'Select invoices to pay'
                : `Pay ${paying.length} invoice${paying.length === 1 ? '' : 's'}`}
            </span>
            <span className="text-[15px] font-semibold tabular-nums">
              {formatCents(paying.length === 0 ? summary.outstanding : payingTotal)}
            </span>
          </button>
        </div>
      ) : null}

      <PaymentSheet
        open={payOpen}
        onOpenChange={setPayOpen}
        rows={sheetRows}
        onPaid={(payment) => {
          setSelected(new Set());
          setToast(`Paid ${formatCents(payment.amount)} · ${payment.confirmationNumber}`);
          setTimeout(() => setToast(null), 4000);
        }}
      />

      {toast ? (
        <output className="fixed inset-x-4 bottom-32 z-40 block rounded-lg bg-text px-4 py-3 text-sm text-surface shadow-[var(--shadow-lifted)] lg:inset-x-auto lg:right-6 lg:bottom-24 lg:max-w-sm">
          {toast}
        </output>
      ) : null}
    </>
  );
}

function InvoiceListRow({
  row,
  now,
  checked,
  onToggle,
  onOpenOrder,
}: {
  row: InvoiceRow;
  now: string;
  checked: boolean;
  onToggle: (invoiceId: string) => void;
  onOpenOrder?: ((orderId: string) => void) | undefined;
}) {
  const { invoice } = row;
  // Due dates carry colour only when they mean something: red is late, amber
  // is "this week". Painting every date makes none of them signal.
  const dueColor = row.overdue
    ? 'var(--danger)'
    : new Date(invoice.dueAt).getTime() - new Date(now).getTime() < 7 * 86_400_000
      ? 'var(--warning)'
      : undefined;

  return (
    <li className="flex items-stretch border-border border-b bg-surface">
      <label className="flex min-h-16 flex-1 cursor-pointer items-center gap-3 px-4 py-3 lg:px-6">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(invoice.id)}
          className="sr-only"
        />
        <span
          aria-hidden
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
            checked ? 'border-brand bg-brand text-brand-on' : 'border-text-subtle',
          )}
        >
          {checked ? <Check size={15} strokeWidth={3.5} /> : null}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium">{row.label}</span>
          <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-text-muted">
            <span className="text-data">{invoice.number}</span>
            {invoice.origin === 'counter' ? (
              <span className="rounded bg-surface-3 px-1.5 py-px text-[10.5px]">Counter sale</span>
            ) : null}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-[15px] font-semibold tabular-nums">
            {formatCents(invoice.balance)}
          </span>
          <span className="mt-0.5 block text-[11.5px] tabular-nums" style={{ color: dueColor }}>
            {row.overdue
              ? `${row.daysOverdue} day${row.daysOverdue === 1 ? '' : 's'} late`
              : `Due ${formatDate(invoice.dueAt)}`}
          </span>
        </span>
      </label>

      {onOpenOrder && row.orderId ? (
        <button
          type="button"
          onClick={() => onOpenOrder(row.orderId as string)}
          aria-label={`Open the order behind ${invoice.number}`}
          className="flex w-11 shrink-0 items-center justify-center text-text-subtle transition-colors hover:bg-surface-2 hover:text-text"
        >
          <ChevronRight size={17} strokeWidth={2} />
        </button>
      ) : null}
    </li>
  );
}

function Empty({ title, body, celebrate }: { title: string; body: string; celebrate?: boolean }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 px-8 text-center">
      {celebrate ? <PartyPopper size={26} strokeWidth={1.75} className="text-text-subtle" /> : null}
      <p className="text-[15px] font-medium">{title}</p>
      <p className="max-w-xs text-[13px] text-text-subtle">{body}</p>
    </div>
  );
}
