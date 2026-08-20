// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';
import type { Cents } from '../lib/money';
import type { Address } from './project';

/**
 * Who the contractor is to the supplier.
 *
 * `type` and `paymentTermsCode` are the commercial relationship: a `charge`
 * account on Net-30 can submit orders and settle later, which is why the AR
 * bucket exists at all. A `cash` account pays up front and never accrues a
 * balance.
 */
export interface Account {
  id: EntityId;
  name: string;
  accountNumber: string;
  type: 'cash' | 'charge';
  paymentTermsCode: 'COD' | 'NET15' | 'NET30';
  /** Opaque to the contractor — feeds the ERP pricing engine only. */
  pricingTierId: EntityId;
  creditLimit?: Cents;
  addresses: Address[];
  /** The contractor's own branding, stamped onto customer-facing quotes. */
  branding: ContractorBranding;
}

export interface ContractorBranding {
  companyName: string;
  contactName?: string;
  phone?: string;
  email?: string;
  licenseNumber?: string;
  logoDataUrl?: string;
  accentColor?: string;
}

export interface User {
  id: EntityId;
  accountId: EntityId;
  name: string;
  email: string;
  role: 'owner' | 'estimator' | 'field';
  initials: string;
}

export function termsDays(terms: Account['paymentTermsCode']): number {
  switch (terms) {
    case 'COD':
      return 0;
    case 'NET15':
      return 15;
    case 'NET30':
      return 30;
  }
}
