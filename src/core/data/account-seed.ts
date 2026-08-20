// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Account, User } from '../domain/account';
import type { PaymentMethod } from '../domain/payment';
import type { Address } from '../domain/project';
import { toCents } from '../lib/money';
import type { PricingRule, PricingTier } from '../sim/pricing';
import { categoryId } from './catalog-seed';

/**
 * The demo contractor and the commercial terms the supplier has them on.
 *
 * The pricing rules below are deliberately varied rather than one flat
 * discount. A contractor scanning their scope should be able to see that the
 * relationship is worth something specific: better-than-baseline on the
 * category they buy most, a locked price their rep negotiated, and volume
 * breaks on the commodity items they buy by the hundred. A single uniform
 * discount would price everything correctly and communicate nothing.
 *
 * None of this is visible to the contractor as rules — only as their price.
 */

export const ACCOUNT_ID = 'acct_summit';
export const USER_ID = 'usr_demo';
export const TIER_PRO_ID = 'tier_pro';

const YARD_ADDRESS: Address = {
  id: 'addr_shop',
  label: 'Shop',
  line1: '1400 W Industrial Ave',
  city: 'Sioux Falls',
  state: 'SD',
  zip: '57104',
};

export const DEMO_ADDRESSES: Address[] = [YARD_ADDRESS];

export const PRICING_TIERS: PricingTier[] = [
  { id: 'tier_standard', name: 'Standard', percentOffList: 0 },
  { id: 'tier_preferred', name: 'Preferred', percentOffList: 6 },
  // The demo account. A real pro account, not a walk-in.
  { id: TIER_PRO_ID, name: 'Pro', percentOffList: 12 },
];

/** Category ids from the salvaged catalog, named for readability. */
const CAT_LUMBER = categoryId(1);
const CAT_DECKING = categoryId(21);

export const PRICING_RULES: PricingRule[] = [
  // Their bread and butter — better than the tier baseline.
  {
    kind: 'category',
    accountId: ACCOUNT_ID,
    categoryId: CAT_LUMBER,
    percentOffList: 18,
  },
  // Everyone on Pro gets a bit more off decking.
  {
    kind: 'category',
    tierId: TIER_PRO_ID,
    categoryId: CAT_DECKING,
    percentOffList: 15,
  },
  // A negotiated, locked price. Immune to list changes — the thing a
  // contractor calls their rep about.
  {
    kind: 'contract',
    accountId: ACCOUNT_ID,
    sku: 'LBR-2X4-8-DF',
    unitPrice: toCents(4.62),
  },
  // Volume breaks across lumber. Expressed as extra percentage off rather than
  // an absolute price, because this category spans a $6 stud and a $30 post —
  // a single absolute break price would be nonsense on most of it.
  {
    kind: 'volume',
    categoryId: CAT_LUMBER,
    breaks: [
      { minQty: 100, extraPercentOff: 7 },
      { minQty: 500, extraPercentOff: 12 },
    ],
  },
  // An absolute break, valid because it names one sku.
  {
    kind: 'volume',
    sku: 'LBR-2X4-8-DF',
    breaks: [{ minQty: 250, unitPrice: toCents(3.98) }],
  },
];

export const DEMO_ACCOUNT: Account = {
  id: ACCOUNT_ID,
  name: 'Summit Ridge Builders',
  accountNumber: 'ACCT-1042',
  type: 'charge',
  paymentTermsCode: 'NET30',
  pricingTierId: TIER_PRO_ID,
  creditLimit: toCents(75_000),
  addresses: DEMO_ADDRESSES,
  branding: {
    companyName: 'Summit Ridge Builders',
    contactName: 'Dana Reyes',
    phone: '(605) 555-0142',
    email: 'dana@summitridgebuilds.com',
    licenseNumber: 'SD-GC-88431',
  },
};

export const DEMO_USER: User = {
  id: USER_ID,
  accountId: ACCOUNT_ID,
  name: 'Dana Reyes',
  email: 'dana@summitridgebuilds.com',
  role: 'owner',
  initials: 'DR',
};

/**
 * Saved methods. The "•••• 0002" card always fails in the simulator — a demo
 * that only ever shows the happy path teaches nothing about what a decline
 * looks like.
 */
export const SEED_PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: 'pm_ach',
    accountId: ACCOUNT_ID,
    kind: 'ach',
    label: 'Business checking ••4471',
    isDefault: true,
  },
  {
    id: 'pm_visa',
    accountId: ACCOUNT_ID,
    kind: 'card',
    label: 'Visa •••• 4242',
    isDefault: false,
    expiry: '09/29',
  },
  {
    id: 'pm_bad',
    accountId: ACCOUNT_ID,
    kind: 'card',
    label: 'Visa •••• 0002',
    isDefault: false,
    expiry: '01/28',
  },
];
