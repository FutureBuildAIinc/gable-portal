// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';

/**
 * The contractor's own people.
 *
 * A six-person outfit is not one login: the owner runs the board, a PM builds
 * scopes and talks to the dealer, someone's spouse or a bookkeeper pays the
 * bills, and the crew picks things up. The roles here mirror that division —
 * and the permission checks live in the ACTIONS layer, the single mutation
 * path, so the UI, the board drag, and the AI assistant are all gated by the
 * same rule with the same sentence.
 */

export type TeamRole = 'owner' | 'pm' | 'ap' | 'field';

export interface TeamMember {
  id: EntityId;
  name: string;
  role: TeamRole;
  email?: string | undefined;
  initials: string;
  createdAt: string;
}

/**
 * What a role may do. Everything not listed is readable by everyone — this is
 * a small company's tool, and hiding information from your own people creates
 * more phone calls than it prevents. Only ACTIONS are gated.
 */
export type Capability =
  | 'edit-scope' // build and change draft orders
  | 'move-stage' // send to the quote desk, place with the dealer, pull back
  | 'customer-quote' // build, revise, and send proposals to the homeowner
  | 'pay' // pay invoices, manage payment methods
  | 'confirm-pickup' // "I've got it" at the will-call counter
  | 'manage-team'; // add and remove people, change roles

const GRANTS: Record<TeamRole, readonly Capability[]> = {
  owner: ['edit-scope', 'move-stage', 'customer-quote', 'pay', 'confirm-pickup', 'manage-team'],
  pm: ['edit-scope', 'move-stage', 'customer-quote', 'confirm-pickup'],
  ap: ['pay'],
  field: ['confirm-pickup'],
};

export function can(role: TeamRole, capability: Capability): boolean {
  return GRANTS[role].includes(capability);
}

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Owner',
  pm: 'Project manager',
  ap: 'Accounts payable',
  field: 'Field',
};

/** One sentence per role, in the words the owner would use to explain it. */
export const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  owner: 'Everything — orders, quotes, payments, and the team.',
  pm: 'Builds orders, works the quote desk, and sends customer quotes. No payments.',
  ap: 'Sees everything, pays invoices, manages payment methods. No ordering.',
  field: 'Sees orders and deliveries, confirms will-call pickups. Read-only otherwise.',
};

/** What a capability is FOR, used to build refusal sentences. */
export const CAPABILITY_VERBS: Record<Capability, string> = {
  'edit-scope': 'edit orders',
  'move-stage': 'send orders to the supplier',
  'customer-quote': 'manage customer quotes',
  pay: 'make payments',
  'confirm-pickup': 'confirm pickups',
  'manage-team': 'manage the team',
};

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
