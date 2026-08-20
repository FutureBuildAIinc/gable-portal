// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toolByName } from '../../ai/tools';
import { boot } from '../../boot';
import { resetConfigCache } from '../../config/runtime';
import { DEFAULT_CONFIG } from '../../domain/config';
import { can } from '../../domain/team';
import { flushPersistence } from '../../stores/persistence';
import { teamStore } from '../../stores/root';
import { buildCustomerQuote } from '../customer-quote';
import { createOrder, moveOrderToStage, updateOrder } from '../orders';
import { payInvoices } from '../payments';
import { addCatalogItem } from '../scope';
import {
  activeMember,
  addTeamMember,
  removeTeamMember,
  setMemberRole,
  switchActiveMember,
  teamMembers,
} from '../team';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

const DANA = 'tm_dana'; // owner
const MARCUS = 'tm_marcus'; // pm
const ROBIN = 'tm_robin'; // ap
const TY = 'tm_ty'; // field

const PERGOLA = 'ord_miller_pergola';
const MILLER_FRAME = 'ord_miller_frame';

beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

describe('the capability matrix', () => {
  it('divides the company the way a small outfit actually divides it', () => {
    // The owner does everything; nobody else pays AND orders.
    expect(can('owner', 'pay') && can('owner', 'move-stage')).toBe(true);
    expect(can('pm', 'move-stage')).toBe(true);
    expect(can('pm', 'pay')).toBe(false);
    expect(can('ap', 'pay')).toBe(true);
    expect(can('ap', 'edit-scope')).toBe(false);
    expect(can('field', 'confirm-pickup')).toBe(true);
    expect(can('field', 'edit-scope')).toBe(false);
    // Only owners shape the team itself.
    for (const role of ['pm', 'ap', 'field'] as const) {
      expect(can(role, 'manage-team')).toBe(false);
    }
  });

  it('boots with Dana acting and the full seeded crew', () => {
    expect(activeMember()?.id).toBe(DANA);
    expect(teamMembers().map((member) => member.id)).toEqual([DANA, MARCUS, ROBIN, TY]);
  });
});

describe('gating the single mutation path', () => {
  it('lets the A/P person pay but not order — and the refusal names who can', () => {
    switchActiveMember(ROBIN);

    const moved = moveOrderToStage(MILLER_FRAME, 'quote');
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    // The sentence solves the problem: it says WHO to ask.
    expect(moved.error).toContain('Dana Reyes');
    expect(moved.error).toContain('Marcus Webb');
    expect(moved.error).toContain('Robin Alvarez');
  });

  it('lets the PM order but not pay', () => {
    switchActiveMember(MARCUS);

    expect(moveOrderToStage(MILLER_FRAME, 'quote').ok).toBe(true);

    const paid = payInvoices({ invoiceIds: ['inv_kirkland'], methodId: 'pm_ach' });
    expect(paid.ok).toBe(false);
    if (paid.ok) return;
    expect(paid.error).toMatch(/payments/i);
    expect(paid.error).toContain('Robin Alvarez');
  });

  it('keeps the field role read-only on scope', () => {
    switchActiveMember(TY);
    const added = addCatalogItem({ orderId: PERGOLA, product: 'LBR-2X4-8-DF', qty: 10 });
    expect(added.ok).toBe(false);
  });

  it('gates the AI assistant through the very same sentence', () => {
    switchActiveMember(ROBIN);
    const tool = toolByName('add_materials');
    const result = tool?.run({ orderId: PERGOLA, product: 'LBR-2X4-8-DF', qty: 10 });
    expect(result?.ok).toBe(false);
    if (!result || result.ok) return;
    expect(result.error).toContain('edit orders');
  });

  it('blocks a PM from quoting the customer? No — that is their job', () => {
    switchActiveMember(MARCUS);
    expect(buildCustomerQuote(MILLER_FRAME).ok).toBe(true);
  });
});

describe('managing the team', () => {
  it('is owner-only', () => {
    switchActiveMember(MARCUS);
    expect(addTeamMember({ name: 'Sam Ortiz', role: 'field' }).ok).toBe(false);
    expect(setMemberRole(TY, 'pm').ok).toBe(false);
    expect(removeTeamMember(TY).ok).toBe(false);
  });

  it('adds a teammate who then acts with their role', () => {
    const added = addTeamMember({ name: 'Sam Ortiz', role: 'ap' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.initials).toBe('SO');

    switchActiveMember(added.value.id);
    expect(payInvoices({ invoiceIds: ['inv_counter'], methodId: 'pm_ach' }).ok).toBe(true);
  });

  it('never leaves the company without an owner', () => {
    expect(setMemberRole(DANA, 'field').ok).toBe(false);
    expect(removeTeamMember(DANA).ok).toBe(false);

    // Promote Marcus, and Dana may step down.
    expect(setMemberRole(MARCUS, 'owner').ok).toBe(true);
    expect(setMemberRole(DANA, 'pm').ok).toBe(true);
  });

  it('will not remove the person currently acting', () => {
    switchActiveMember(DANA);
    setMemberRole(MARCUS, 'owner');
    switchActiveMember(MARCUS);
    const removed = removeTeamMember(MARCUS);
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    expect(removed.error).toMatch(/switch/i);
  });

  it('persists who is acting across a reload', () => {
    switchActiveMember(ROBIN);
    flushPersistence(); // what pagehide does on a real navigation
    boot({ seed: 20_260_730 }); // no reset — restore
    expect(activeMember()?.id).toBe(ROBIN);
  });
});

describe('with no team at all', () => {
  it('everything is allowed — the gate exists once people exist', () => {
    teamStore.set({ members: { byId: {}, allIds: [] }, activeId: null });
    expect(moveOrderToStage(MILLER_FRAME, 'quote').ok).toBe(true);
  });
});

describe('a save that predates the team', () => {
  /**
   * Stores are persisted only once they change, and persistence attaches after
   * seeding — so a session that never touched the team and then died without a
   * pagehide flush leaves `gn:team` absent while the board keys are present.
   * Restore used to succeed with an empty team, which makes activeMember()
   * undefined and every capability check pass: an old save silently turned the
   * permission gate off.
   */
  it('reseeds the crew rather than restoring with the gate wide open', () => {
    boot({ reset: true, seed: 20_260_730 });
    flushPersistence();

    // The board survived; the team key never got written.
    localStorage.removeItem('gn:team');
    teamStore.set({ members: { byId: {}, allIds: [] }, activeId: null });

    boot({ seed: 20_260_730 });

    expect(teamMembers().length).toBeGreaterThan(0);
    expect(activeMember()).toBeDefined();

    // And the gate is genuinely back on.
    switchActiveMember(ROBIN);
    expect(moveOrderToStage(MILLER_FRAME, 'quote').ok).toBe(false);
  });
});

describe('dealer feature flags reach the actions layer', () => {
  /**
   * A flag that only hides a button is a lie the admin console tells: the
   * dealer believes will-call is off while any other route still creates one.
   * Gating it here means the promise holds however the order is made.
   */
  it('refuses will-call when the dealer does not offer pickup', () => {
    resetConfigCache({
      ...DEFAULT_CONFIG,
      features: { ...DEFAULT_CONFIG.features, willCall: false },
    });

    const created = createOrder({
      projectId: 'prj_miller',
      name: 'Pickup order',
      fulfillment: 'willcall',
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error).toMatch(/does not offer will-call/i);

    // And an existing order cannot be switched to it either.
    const switched = updateOrder(PERGOLA, { fulfillment: 'willcall' });
    expect(switched.ok).toBe(false);

    resetConfigCache();
  });

  it('allows will-call by default', () => {
    resetConfigCache();
    expect(
      createOrder({ projectId: 'prj_miller', name: 'Pickup order', fulfillment: 'willcall' }).ok,
    ).toBe(true);
  });
});
