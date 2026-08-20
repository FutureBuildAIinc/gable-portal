// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { dealerConfig } from '../config/runtime';
import type { EntityId } from '../lib/ids';
import { type Cents, applyPercent } from '../lib/money';
import type { IsoDateTime } from '../lib/time';

/**
 * Accounts receivable, from the contractor's side.
 *
 * A charge account is the reason this bucket exists: materials go out, an
 * invoice follows, and the contractor settles on terms. Paying it should take
 * seconds, because chasing a portal for a payment link is exactly the friction
 * that sends people back to phoning the counter.
 */

export type PaymentMethodKind = 'ach' | 'card';

export interface PaymentMethod {
  id: EntityId;
  accountId: EntityId;
  kind: PaymentMethodKind;
  /** Display only. Never a real PAN — this is a prototype and stays one. */
  label: string;
  isDefault: boolean;
  expiry?: string;
}

export type PaymentStatus = 'processing' | 'succeeded' | 'failed';

export interface Payment {
  id: EntityId;
  accountId: EntityId;
  methodId: EntityId;
  /** One payment can settle several invoices — that is the "few clicks" part. */
  allocations: { invoiceId: EntityId; amount: Cents }[];
  amount: Cents;
  status: PaymentStatus;
  initiatedAt: IsoDateTime;
  settledAt?: IsoDateTime;
  confirmationNumber?: string;
  failureReason?: string;
}

/**
 * Card processing costs the dealer, so it is passed through. ACH is free.
 *
 * The rate is dealer-configurable, but it is read through one function that
 * every caller already used — so the number shown before choosing a method and
 * the number actually charged still cannot drift apart.
 */
export const CARD_FEE_PERCENT = 2.9;

export function cardFeePercent(): number {
  return dealerConfig().supplier.cardFeePercent;
}

export function feeFor(method: PaymentMethod, amount: Cents): Cents {
  return method.kind === 'card' ? applyPercent(amount, cardFeePercent()) : 0;
}

export type AgingBucket = 'current' | '1-30' | '31-60' | '60+';

export const AGING_BUCKETS: readonly AgingBucket[] = ['current', '1-30', '31-60', '60+'] as const;

export const AGING_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  '1-30': '1-30 days',
  '31-60': '31-60 days',
  '60+': '60+ days',
};

/**
 * Whole days past due; 0 when the invoice is not yet a full day late.
 *
 * This is THE definition of past-due — agingBucket and isOverdue are both
 * derived from it. They used to disagree (bucket floored to days, overdue
 * compared raw timestamps), so an invoice due yesterday evening spent a day
 * counted in the overdue headline while filed under the 'Current' tile on the
 * same screen.
 */
export function daysPastDue(dueAt: IsoDateTime, now: IsoDateTime): number {
  return Math.max(
    0,
    Math.floor((new Date(now).getTime() - new Date(dueAt).getTime()) / 86_400_000),
  );
}

/** Days past due, bucketed the way an AR statement does it. */
export function agingBucket(dueAt: IsoDateTime, now: IsoDateTime): AgingBucket {
  const daysOverdue = daysPastDue(dueAt, now);
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  return '60+';
}

export function isOverdue(dueAt: IsoDateTime, now: IsoDateTime): boolean {
  return daysPastDue(dueAt, now) > 0;
}
