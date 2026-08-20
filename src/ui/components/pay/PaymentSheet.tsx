// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { defaultPaymentMethod, payInvoices } from '@core/actions/payments';
import { supplierName } from '@core/config/runtime';
import { type Payment, type PaymentMethod, cardFeePercent, feeFor } from '@core/domain/payment';
import { type Cents, formatCents } from '@core/lib/money';
import type { InvoiceRow } from '@core/selectors/ar';
import { paymentMethodsStore } from '@core/stores/root';
import { listOf } from '@core/stores/store';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { shallowArrayEqual, useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { AlertCircle, Building2, Check, CreditCard, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Paying. Three clicks from the invoice list, and no surprises inside them.
 *
 * The method picker prices every option rather than only the selected one,
 * because the difference between ACH and a card on a $14k material invoice is
 * about $400. A contractor who only learns that on the receipt has been taken
 * advantage of by the interface.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Snapshotted at open time so the receipt still names what was paid. */
  rows: InvoiceRow[];
  onPaid?: ((payment: Payment) => void) | undefined;
}

type Phase = 'review' | 'processing' | 'receipt';

/** Long enough to read as "it went somewhere", short enough not to annoy. */
const SETTLE_MS = 700;

export function PaymentSheet({ open, onOpenChange, rows, onPaid }: Props) {
  const methods = useStore(paymentMethodsStore, listOf, shallowArrayEqual);

  const [methodId, setMethodId] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('review');
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reopening is a fresh attempt: a receipt or a decline from last time must
  // not be the first thing they see. And closing must KILL the settle timer —
  // otherwise "Cancel" during processing still charges the card two seconds
  // later, against a sheet that no longer exists to show the receipt.
  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!open) return;
    setPhase('review');
    setPayment(null);
    setError(null);
    setMethodId(defaultPaymentMethod()?.id ?? '');
  }, [open]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const invoiceIds = rows.map((row) => row.invoice.id);
  const subtotal = rows.reduce((sum, row) => sum + row.invoice.balance, 0);
  const method = methods.find((candidate) => candidate.id === methodId);
  const fee = method ? feeFor(method, subtotal) : 0;
  const total = subtotal + fee;

  const declined = payment?.status === 'failed' ? payment : null;

  function pay() {
    if (!method) return;
    setError(null);
    setPayment(null);
    setPhase('processing');

    timer.current = setTimeout(() => {
      const result = payInvoices({ invoiceIds, methodId: method.id });
      if (!result.ok) {
        // A guard rejection, not a decline — the invoice moved under them.
        setError(result.error);
        setPhase('review');
        return;
      }
      setPayment(result.value);
      setPhase(result.value.status === 'succeeded' ? 'receipt' : 'review');
      if (result.value.status === 'succeeded') onPaid?.(result.value);
    }, SETTLE_MS);
  }

  const heading =
    phase === 'receipt'
      ? 'Payment complete'
      : rows.length === 1
        ? `Pay ${rows[0]?.invoice.number ?? 'invoice'}`
        : `Pay ${rows.length} invoices`;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={heading}
      description={
        phase === 'receipt' ? undefined : `${formatCents(subtotal)} owed to ${supplierName()}`
      }
      footer={
        phase === 'receipt' ? (
          <Button full size="lg" variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <Button
            full
            size="lg"
            onClick={pay}
            disabled={phase === 'processing' || !method || rows.length === 0}
          >
            {phase === 'processing' ? (
              <>
                <Loader2 size={17} className="animate-spin" />
                Paying…
              </>
            ) : (
              `Pay ${formatCents(total)}`
            )}
          </Button>
        )
      }
    >
      {phase === 'receipt' && payment ? (
        <Receipt payment={payment} rows={rows} />
      ) : (
        <div className="space-y-4 pb-1">
          {declined ? (
            <p
              className="flex items-start gap-2 rounded-[var(--radius-card)] p-3 text-[13px] leading-relaxed"
              style={{ background: 'color-mix(in oklch, var(--danger), transparent 88%)' }}
            >
              <AlertCircle
                size={16}
                className="mt-px shrink-0"
                style={{ color: 'var(--danger)' }}
              />
              <span>
                <strong className="font-semibold">
                  {declined.failureReason ?? 'The payment was declined.'}
                </strong>{' '}
                Nothing was charged and your balance is unchanged. Try another method below.
              </span>
            </p>
          ) : null}

          {error ? (
            <p className="rounded-[var(--radius-card)] bg-surface-inset p-3 text-[13px] text-danger">
              {error}
            </p>
          ) : null}

          <section>
            <h3 className="mb-1.5 text-[12px] font-semibold text-text-muted">Paying</h3>
            <ul className="overflow-hidden rounded-[var(--radius-card)] border border-border">
              {rows.map((row) => (
                <li
                  key={row.invoice.id}
                  className="flex items-baseline justify-between gap-3 border-border border-b px-3 py-2.5 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{row.label}</span>
                    <span className="text-data text-text-subtle">{row.invoice.number}</span>
                  </span>
                  <span className="shrink-0 text-[13px] tabular-nums">
                    {formatCents(row.invoice.balance)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1.5 text-[12px] font-semibold text-text-muted">Pay with</h3>
            <ul className="space-y-1.5">
              {methods.map((candidate) => (
                <li key={candidate.id}>
                  <MethodOption
                    method={candidate}
                    subtotal={subtotal}
                    selected={candidate.id === methodId}
                    onSelect={setMethodId}
                  />
                </li>
              ))}
            </ul>
          </section>

          <dl className="space-y-1.5 border-border border-t pt-3 text-[13px]">
            <Line label="Invoice total" value={formatCents(subtotal)} />
            {fee > 0 ? (
              <>
                <Line
                  label={`Card processing fee (${cardFeePercent()}%)`}
                  value={formatCents(fee)}
                />
                <p className="text-[12px] text-text-subtle">
                  Paying by bank transfer would save you {formatCents(fee)}.
                </p>
              </>
            ) : null}
            <div className="flex items-baseline justify-between border-border border-t pt-2 font-semibold">
              <dt>Total</dt>
              <dd className="text-[17px] tabular-nums">{formatCents(total)}</dd>
            </div>
          </dl>
        </div>
      )}
    </Sheet>
  );
}

function MethodOption({
  method,
  subtotal,
  selected,
  onSelect,
}: {
  method: PaymentMethod;
  subtotal: Cents;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const fee = feeFor(method, subtotal);
  const Icon = method.kind === 'ach' ? Building2 : CreditCard;

  return (
    <button
      type="button"
      onClick={() => onSelect(method.id)}
      aria-pressed={selected}
      className={cn(
        'flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-card)] border px-3 text-left transition-colors',
        selected ? 'border-brand bg-brand-tint' : 'border-border hover:bg-surface-2',
      )}
    >
      <Icon size={18} strokeWidth={2} className={selected ? 'text-brand' : 'text-text-muted'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{method.label}</span>
        <span
          className="text-[12px]"
          style={{ color: fee === 0 ? 'var(--success)' : 'var(--text-muted)' }}
        >
          {fee === 0 ? 'No fee' : `${cardFeePercent()}% fee · ${formatCents(fee)}`}
        </span>
      </span>
      {method.isDefault ? (
        <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10.5px] text-text-muted">
          Default
        </span>
      ) : null}
    </button>
  );
}

function Receipt({ payment, rows }: { payment: Payment; rows: InvoiceRow[] }) {
  return (
    <div className="space-y-4 py-2 text-center">
      <div
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in oklch, var(--success), transparent 85%)' }}
      >
        <Check size={28} strokeWidth={2.5} style={{ color: 'var(--success)' }} />
      </div>

      <div>
        <p className="text-[26px] font-semibold tabular-nums">{formatCents(payment.amount)}</p>
        <p className="mt-0.5 text-[13px] text-text-muted">
          {rows.length === 1
            ? `${rows[0]?.invoice.number} is paid in full.`
            : `${rows.length} invoices paid in full.`}
        </p>
      </div>

      <dl className="space-y-1.5 rounded-[var(--radius-card)] bg-surface-inset p-3 text-left text-[13px]">
        <div className="flex justify-between gap-3">
          <dt className="text-text-muted">Confirmation</dt>
          {/* The number they will quote if they ever have to ring the desk. */}
          <dd className="text-data font-medium">{payment.confirmationNumber}</dd>
        </div>
        {rows.map((row) => (
          <div key={row.invoice.id} className="flex justify-between gap-3">
            <dt className="min-w-0 truncate text-text-muted">{row.label}</dt>
            <dd className="text-data shrink-0 text-text-subtle">{row.invoice.number}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
