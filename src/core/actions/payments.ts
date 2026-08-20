// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '../boot';
import {
  type Payment,
  type PaymentMethod,
  type PaymentMethodKind,
  feeFor,
} from '../domain/payment';
import type { Invoice } from '../domain/supplier';
import { newId } from '../lib/ids';
import { type Cents, formatCents } from '../lib/money';
import { type Result, err, ok } from '../lib/result';
import type { IsoDateTime } from '../lib/time';
import {
  activityStore,
  invoicesStore,
  paymentMethodsStore,
  paymentsStore,
  sessionStore,
} from '../stores/root';
import { listOf, patch, remove, upsert } from '../stores/store';
import { requireCapability } from './team';

/**
 * Settling accounts receivable.
 *
 * The product promise is "few clicks", so one payment settles many invoices in
 * a single allocation set rather than making the contractor pay them one at a
 * time. Everything a card costs is surfaced before the button is pressed —
 * a 2.9% fee on a $14,000 material invoice is $406, and hiding it until the
 * receipt is how a portal loses trust it will not get back.
 */

/**
 * The seeded "Visa •••• 0002" always declines. A demo that only ever shows the
 * happy path teaches nothing about what a decline looks like, and the decline
 * path is where a payment UI either holds up or falls apart.
 */
const ALWAYS_DECLINES = 'pm_bad';
const DECLINE_REASON = 'Card declined by issuer.';

function nowIso(): IsoDateTime {
  return getContext().clock.nowIso();
}

function log(kind: string, message: string, orderId?: string, actor: 'user' | 'system' = 'user') {
  const state = activityStore.get();
  activityStore.set({
    ...state,
    entries: [
      { id: newId('act'), at: nowIso(), actor, kind, message, ...(orderId ? { orderId } : {}) },
      ...state.entries,
    ].slice(0, 400),
  });
}

export function paymentMethods(): PaymentMethod[] {
  return listOf(paymentMethodsStore.get());
}

export function defaultPaymentMethod(): PaymentMethod | undefined {
  const methods = paymentMethods();
  return methods.find((method) => method.isDefault) ?? methods[0];
}

export interface PaymentQuote {
  invoices: Invoice[];
  method: PaymentMethod;
  /** Sum of the balances being settled. */
  subtotal: Cents;
  fee: Cents;
  total: Cents;
}

/**
 * What this payment would cost, without committing to it.
 *
 * Shared with payInvoices deliberately: the sheet shows the number this
 * returns and the action charges the number this returns, so the two cannot
 * drift apart.
 */
export function quotePayment(
  invoiceIds: readonly string[],
  methodId: string,
): Result<PaymentQuote> {
  const unique = [...new Set(invoiceIds)];
  if (unique.length === 0) return err('Select at least one invoice to pay.');

  const method = paymentMethodsStore.get().byId[methodId];
  if (!method) return err('Choose a payment method.');

  const collection = invoicesStore.get();
  const invoices: Invoice[] = [];

  for (const id of unique) {
    const invoice = collection.byId[id];
    if (!invoice) return err('That invoice no longer exists.');
    if (invoice.balance <= 0) return err(`${invoice.number} has already been paid.`);
    invoices.push(invoice);
  }

  const subtotal = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);
  const fee = feeFor(method, subtotal);

  return ok({ invoices, method, subtotal, fee, total: subtotal + fee });
}

export interface PayInvoicesInput {
  invoiceIds: readonly string[];
  methodId: string;
}

/**
 * Pay one or more invoices in full.
 *
 * The payment is written as 'processing' and then settled in the same call.
 * A real processor answers over a network; here there is nobody to wait for,
 * and faking latency inside a pure action would make it untestable and would
 * put a timer in the core. The UI owns the pause that makes it feel real — this
 * owns the money.
 *
 * Partial payment is deliberately not supported: allocations always clear the
 * full balance, because "pay some of it" is a conversation with a rep, not a
 * button.
 */
export function payInvoices(input: PayInvoicesInput): Result<Payment> {
  const gate = requireCapability('pay');
  if (!gate.ok) return gate;

  const quoted = quotePayment(input.invoiceIds, input.methodId);
  if (!quoted.ok) return quoted;

  const { invoices, method, total } = quoted.value;
  const at = nowIso();

  const payment: Payment = {
    id: newId('pay'),
    accountId: method.accountId,
    methodId: method.id,
    allocations: invoices.map((invoice) => ({ invoiceId: invoice.id, amount: invoice.balance })),
    amount: total,
    status: 'processing',
    initiatedAt: at,
  };
  paymentsStore.set(upsert(paymentsStore.get(), payment));

  // A single order id only when there is one, so the activity entry can deep
  // link. A payment spanning three jobs belongs to no single card.
  const only = invoices.length === 1 ? invoices[0] : undefined;
  const orderId = only?.orderId;

  if (method.id === ALWAYS_DECLINES) {
    const failed: Payment = { ...payment, status: 'failed', failureReason: DECLINE_REASON };
    paymentsStore.set(upsert(paymentsStore.get(), failed));

    // Balances are untouched. A declined payment that silently zeroed an
    // invoice would be the worst bug this screen could ship.
    log(
      'payment.declined',
      `${formatCents(total)} payment declined — ${DECLINE_REASON}`,
      orderId,
      'system',
    );
    return ok(failed);
  }

  const settled: Payment = {
    ...payment,
    status: 'succeeded',
    settledAt: at,
    confirmationNumber: nextConfirmationNumber(),
  };
  paymentsStore.set(upsert(paymentsStore.get(), settled));

  let collection = invoicesStore.get();
  for (const invoice of invoices) {
    collection = patch(collection, invoice.id, { balance: 0 });
  }
  invoicesStore.set(collection);

  const what = invoices.length === 1 ? (only?.number ?? 'invoice') : `${invoices.length} invoices`;
  log(
    'payment.succeeded',
    `Paid ${what} — ${formatCents(total)} on ${method.label} (${settled.confirmationNumber})`,
    orderId,
  );

  return ok(settled);
}

/** Counts successes only, so the numbers a contractor sees have no gaps. */
function nextConfirmationNumber(): string {
  const succeeded = listOf(paymentsStore.get()).filter(
    (payment) => payment.status === 'succeeded',
  ).length;
  return `PMT-${10_000 + succeeded + 1}`;
}

export interface SavePaymentMethodInput {
  kind: PaymentMethodKind;
  label: string;
}

/**
 * Add a method to the account.
 *
 * There is no card number here and there never will be. `label` is display
 * text only ("Visa •••• 4242"); this prototype has no processor, no vault, and
 * no business holding a PAN. The digit guard below is not validation — it is a
 * refusal to accept something that should never have been typed.
 */
export function savePaymentMethod(input: SavePaymentMethodInput): Result<PaymentMethod> {
  const gate = requireCapability('pay');
  if (!gate.ok) return gate;

  const account = sessionStore.get().account;
  if (!account) return err('No account is signed in.');

  const label = input.label.trim();
  if (!label) return err('Give this method a name you will recognize.');

  const digits = label.replace(/\D/g, '').length;
  if (digits >= 12) {
    return err('Enter a nickname like “Visa •••• 4242” — never a full card number.');
  }

  const existing = paymentMethods();
  const method: PaymentMethod = {
    id: newId('pm'),
    accountId: account.id,
    kind: input.kind,
    label,
    // The first method on file is the default by definition; nothing else is.
    isDefault: existing.length === 0,
  };

  paymentMethodsStore.set(upsert(paymentMethodsStore.get(), method));
  log('payment-method.added', `Added ${label}`);
  return ok(method);
}

export function setDefaultPaymentMethod(methodId: string): Result<PaymentMethod> {
  const gate = requireCapability('pay');
  if (!gate.ok) return gate;

  const target = paymentMethodsStore.get().byId[methodId];
  if (!target) return err('That payment method no longer exists.');

  let collection = paymentMethodsStore.get();
  for (const method of listOf(collection)) {
    const isDefault = method.id === methodId;
    if (method.isDefault !== isDefault) {
      collection = patch(collection, method.id, { isDefault });
    }
  }
  paymentMethodsStore.set(collection);

  return ok({ ...target, isDefault: true });
}

export function removePaymentMethod(methodId: string): Result<PaymentMethod> {
  const gate = requireCapability('pay');
  if (!gate.ok) return gate;

  const target = paymentMethodsStore.get().byId[methodId];
  if (!target) return err('That payment method no longer exists.');

  const remaining = paymentMethods().filter((method) => method.id !== methodId);
  if (remaining.length === 0) {
    return err('Keep at least one payment method on file so you can settle an invoice.');
  }

  let collection = remove(paymentMethodsStore.get(), methodId);
  // Never leave the account without a default — the payment sheet preselects it.
  if (target.isDefault) {
    const heir = remaining[0] as PaymentMethod;
    collection = patch(collection, heir.id, { isDefault: true });
  }
  paymentMethodsStore.set(collection);

  log('payment-method.removed', `Removed ${target.label}`);
  return ok(target);
}
