// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  DEMO_ACCOUNT,
  DEMO_USER,
  PRICING_RULES,
  PRICING_TIERS,
  SEED_PAYMENT_METHODS,
} from './data/account-seed';
import { seedCatalog } from './data/catalog-seed';
import { buildScenario } from './data/scenario';
import { SEED_TEAM } from './data/team-seed';
import { newId } from './lib/ids';
import { type SimClock, createClock } from './sim/clock';
import { type Sim, createSim } from './sim/index';
import { type PricingEngine, categoryParentsFrom, createPricingEngine } from './sim/pricing';
import {
  SCHEMA_VERSION,
  attachCrossTabSync,
  attachPersistence,
  clearPersistedState,
  loadStoreState,
  migrate,
  readMeta,
  releaseLeadership,
  renewLeadership,
  saveStoreState,
  stashCorruptState,
  tryAcquireLeadership,
  validateStoreState,
  writeMeta,
} from './stores/persistence';
import {
  type CatalogState,
  PERSISTED_STORES,
  activityStore,
  catalogStore,
  customerQuotesStore,
  invoicesStore,
  ordersStore,
  paymentMethodsStore,
  paymentsStore,
  projectsStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
  sessionStore,
  simStore,
  teamStore,
} from './stores/root';
import { collectionFrom } from './stores/store';
import type { SupplierPort } from './supplier/port';
import { createSimSupplier } from './supplier/sim';

/**
 * Wires the app together once, at startup.
 *
 * Order matters: the catalog and pricing engine must exist before the scenario
 * can be built, because the demo data is priced through the same ERP engine the
 * live app uses. Seeded prices are therefore never hand-written numbers that
 * could drift from what the engine would actually produce.
 */

export interface AppContext {
  clock: SimClock;
  /**
   * Who prices a line. The simulator's tier engine when standalone, the ERP's
   * own waterfall when wired — same interface either way, which is the claim
   * `sim/pricing.ts` has carried in a comment since M1 and that
   * `gable/pricing.ts` now makes true.
   */
  pricing: PricingEngine;
  /**
   * The simulator itself. Still here on the wired path because the demo
   * controls and the clock live on it — but its SCHEDULER is stopped once a
   * real ERP is driving state. Prefer `supplier` for anything that talks to the
   * far side of the counter.
   */
  sim: Sim;
  /** The seam. Either the simulator or a live `gable`; callers cannot tell. */
  supplier: SupplierPort;
  seed: number;
}

let context: AppContext | null = null;
/**
 * Persistence subscriptions from a previous boot. Demo Reset calls boot()
 * again, so without disposing these each reset would leave another live
 * subscriber writing to the same key.
 */
let detachPersistence: (() => void)[] = [];
let clockPersistTimer: ReturnType<typeof setInterval> | undefined;
let leaderTimer: ReturnType<typeof setInterval> | undefined;
/** This tab's identity in the cross-tab leadership lease. */
let tabId: string | null = null;
let isLeader = false;

export function getContext(): AppContext {
  if (!context) throw new Error('boot() has not run yet');
  return context;
}

export interface SupplierSwap {
  supplier: SupplierPort;
  pricing: PricingEngine;
  /** The ERP's catalog, replacing the seed. */
  catalog: CatalogState;
}

/**
 * Swap the simulated supplier for a real one, at runtime, after boot.
 *
 * Deliberately NOT a re-boot. A re-boot would wipe and reseed, which is exactly
 * wrong here — connecting to the ERP is meant to REPLACE the supplier, not
 * restart the app, and re-running `boot()` would also re-acquire the cross-tab
 * lease and restart the scheduler this swap exists to stop.
 *
 * Catalog and pricing land in the same call on purpose. Installing ERP products
 * and then ERP prices as two steps leaves a window where a live board prices a
 * real SKU through the simulator's tier table, which is the failure mode the
 * whole integration is correcting. One assignment, no window.
 *
 * `src/core/gable/connect.ts` is the only caller. The UI re-renders because
 * `gableStore` changes, and every consumer of `pricing` reads it through
 * `getContext()` at call time rather than capturing it at import.
 */
export function installSupplier(swap: SupplierSwap): void {
  if (!context) throw new Error('boot() has not run yet');
  catalogStore.set(swap.catalog);
  context = { ...context, supplier: swap.supplier, pricing: swap.pricing };
}

export interface BootOptions {
  /** Fixed seed keeps a demo reproducible; omit for a fresh shuffle. */
  seed?: number;
  /** Ignore persisted state and rebuild from the scenario. */
  reset?: boolean;
}

const DEFAULT_SEED = 20_260_730;

/**
 * Which stores follow another tab's writes.
 *
 * `team` is deliberately excluded. Its `activeId` is who YOU are acting as in
 * THIS window, and adopting it wholesale meant the contractor's tab silently
 * became A/P because someone switched people in another one — which then
 * changes what every button will let them do. The demo's two-window flow is
 * about the homeowner and the board, not about sharing a session identity.
 */
const TAB_LOCAL_KEYS = new Set(['team']);

export function boot(options: BootOptions = {}): AppContext {
  for (const detach of detachPersistence) detach();
  detachPersistence = [];
  context?.sim.scheduler.stop();
  if (clockPersistTimer !== undefined) clearInterval(clockPersistTimer);
  if (leaderTimer !== undefined) clearInterval(leaderTimer);
  // A re-boot (Demo Reset) is the same tab starting over — release the lease
  // so this boot can re-acquire it instead of waiting out its own heartbeat.
  if (tabId) releaseLeadership(tabId);
  tabId = newId('tab');
  isLeader = false;

  let meta = readMeta();
  const seed = options.seed ?? meta?.seed ?? DEFAULT_SEED;

  // A version gap is migrated when every step is covered, wiped when not —
  // a missing step means the bump was a deliberate reseed (see MIGRATIONS).
  if (!options.reset && meta && meta.schemaVersion !== SCHEMA_VERSION) {
    const raw: Record<string, unknown> = {};
    for (const entry of PERSISTED_STORES) {
      const value = loadStoreState<unknown>(entry.key);
      if (value !== null) raw[entry.key] = value;
    }
    const migrated = migrate(raw, meta.schemaVersion);
    if (migrated) {
      for (const entry of PERSISTED_STORES) {
        if (migrated[entry.key] !== undefined) saveStoreState(entry.key, migrated[entry.key]);
      }
      writeMeta({ schemaVersion: SCHEMA_VERSION, seed, savedAt: new Date().toISOString() });
      meta = readMeta();
    }
  }

  // Restore the clock anchor so sim time kept moving while the tab was closed —
  // orders progress "while you were away" rather than freezing on unload.
  const persistedSim = options.reset
    ? null
    : loadStoreState<ReturnType<typeof simStore.get>>('sim');
  const clock = createClock(
    persistedSim && persistedSim.anchorReal > 0
      ? {
          anchorSim: persistedSim.anchorSim,
          anchorReal: persistedSim.anchorReal,
          speed: persistedSim.speed,
        }
      : undefined,
  );
  const catalog = seedCatalog(seed);
  const pricing = createPricingEngine(
    PRICING_TIERS,
    PRICING_RULES,
    categoryParentsFrom(catalog.categories),
  );

  catalogStore.set(catalog);
  sessionStore.set({ account: DEMO_ACCOUNT, user: DEMO_USER });

  const stale = meta !== null && meta.schemaVersion !== SCHEMA_VERSION;
  if (options.reset || stale) clearPersistedState();

  const restored = !options.reset && !stale && restorePersisted();
  if (!restored) {
    quotesStore.set(collectionFrom([]));
    customerQuotesStore.set(collectionFrom([]));
    paymentsStore.set(collectionFrom([]));
    paymentMethodsStore.set(collectionFrom(SEED_PAYMENT_METHODS));
    activityStore.set({ entries: [], readWatermark: new Date(0).toISOString() });
    teamStore.set({
      members: collectionFrom(SEED_TEAM),
      // Dana, the owner, is acting until someone switches.
      activeId: SEED_TEAM[0]?.id ?? null,
    });
    simStore.set({ tasks: [], ...clock.snapshot() });
    const scenario = buildScenario({
      products: catalog.products,
      pricing,
      now: clock.nowIso(),
    });
    projectsStore.set(collectionFrom(scenario.projects));
    ordersStore.set(collectionFrom(scenario.orders));
    scopeStore.set(collectionFrom(scenario.items));
    invoicesStore.set(collectionFrom(scenario.invoices));
    salesOrdersStore.set(collectionFrom(scenario.salesOrders));
  }

  // The sim reads sessionStore, so it is built after the session is set.
  const sim = createSim(clock, seed);
  // Standalone until something connects. `boot()` never reaches the network:
  // an unreachable ERP must degrade to "sign in again", not to a blank app.
  context = { clock, pricing, sim, supplier: createSimSupplier(sim), seed };

  // Keep the persisted clock anchor current so a reload resumes, not restarts.
  // Leader-only: a follower's anchor is a stale copy adopted at boot, and
  // writing it back would drag the shared clock backwards for every tab.
  const persistClock = () => {
    if (!isLeader) return;
    const snap = clock.snapshot();
    const state = simStore.get();
    if (state.anchorSim !== snap.anchorSim || state.anchorReal !== snap.anchorReal) {
      simStore.set({ ...state, ...snap });
    }
  };
  clockPersistTimer = setInterval(persistClock, 2000);

  writeMeta({ schemaVersion: SCHEMA_VERSION, seed, savedAt: new Date().toISOString() });
  detachPersistence = PERSISTED_STORES.map((entry) => attachPersistence(entry.key, entry.store));

  /**
   * Write the whole save NOW, rather than waiting for each store to change.
   *
   * `attachPersistence` only writes on change, which is right for user data and
   * wrong for the seed: on a fresh demo nothing ever changed `projects`,
   * `orders`, or `scope`, so they were never written at all. Building and
   * sending a customer quote wrote `customerQuotes` and `activity` — and a
   * SECOND tab then loaded a save that had a quote but no core trio, failed the
   * trio check in `restorePersisted`, reseeded from scratch, and lost the quote.
   * The share link opened on "This link is no longer valid", which is exactly
   * the two-window accept demo.
   *
   * It also self-healed on any reload, which is why it never showed up in
   * testing: reloading the contractor tab wrote everything and the link
   * started working.
   *
   * A save must be complete from the first moment another tab could read it.
   */
  for (const entry of PERSISTED_STORES) saveStoreState(entry.key, entry.store.get());
  const SHARED_ACROSS_TABS = PERSISTED_STORES.filter((entry) => !TAB_LOCAL_KEYS.has(entry.key));

  // Adopt other tabs' writes as they land. This is what makes the two-window
  // demo true: the homeowner signs in tab B, tab A's board updates live —
  // instead of tab A later clobbering the signature with its stale copy.
  detachPersistence.push(
    attachCrossTabSync(SHARED_ACROSS_TABS, (key) => {
      if (key === 'sim') {
        const adopted = simStore.get();
        if (adopted.anchorReal > 0) {
          clock.restore({
            anchorSim: adopted.anchorSim,
            anchorReal: adopted.anchorReal,
            speed: adopted.speed,
          });
        }
      }
    }),
  );

  // Exactly one tab runs the simulator; the rest adopt its writes. Without
  // this, the flagship two-window flow ran two schedulers over one queue and
  // fired every piece of supplier work twice.
  const watchForLease = () => {
    if (leaderTimer !== undefined) clearInterval(leaderTimer);
    leaderTimer = setInterval(startIfLeader, 3_000);
  };

  /**
   * Stand down after losing the lease.
   *
   * A background tab's timers are throttled to roughly once a minute, so its
   * 2.5s heartbeat can miss the 7s TTL entirely and a foreground tab takes
   * over — correctly. What must not happen is this tab carrying on as if it
   * were still leader: `renewLeadership` refuses to steal the lease back, and
   * this stops the second scheduler that would otherwise be pumping the same
   * persisted queue. It then goes back to watching, so it can take over for
   * real if the new leader closes.
   */
  const standDown = () => {
    isLeader = false;
    context?.sim.scheduler.stop();
    watchForLease();
  };

  const startIfLeader = () => {
    if (!tabId || !context || isLeader) return;
    if (!tryAcquireLeadership(tabId)) return;
    isLeader = true;
    if (leaderTimer !== undefined) clearInterval(leaderTimer);
    leaderTimer = setInterval(() => {
      if (!tabId) return;
      if (!renewLeadership(tabId)) standDown();
    }, 2_500);
    persistClock();
    // Catches up on everything that came due while the tab was closed, then ticks.
    context.sim.scheduler.start();
  };
  startIfLeader();
  if (!isLeader) {
    // Not the leader: poll for a lapsed lease (the leader tab closed or died).
    watchForLease();
  }

  return context;
}

/**
 * All-or-nothing: every present key must parse AND pass shape validation, or
 * the whole save is treated as corrupt — stashed for forensics, wiped, and
 * reseeded. Restoring the valid half of a save is how a card ends up in a
 * stage with no supplier artifact behind it, the exact bug class M6/M7 fought.
 */
function restorePersisted(): boolean {
  const loaded = new Map<string, unknown>();
  for (const entry of PERSISTED_STORES) {
    const value = loadStoreState<unknown>(entry.key);
    if (value === null) continue; // absent is fine — a save from before that milestone
    if (!validateStoreState(entry.key, value)) {
      console.error(`[boot] persisted "${entry.key}" failed validation — reseeding the demo`);
      stashCorruptState(`invalid ${entry.key}`);
      clearPersistedState();
      return false;
    }
    loaded.set(entry.key, value);
  }

  // The core trio must all exist for a save to be a save.
  if (!loaded.has('projects') || !loaded.has('orders') || !loaded.has('scope')) return false;

  for (const entry of PERSISTED_STORES) {
    const value = loaded.get(entry.key);
    if (value !== undefined) entry.store.set(value);
  }

  // Backfill anything the save did not carry.
  //
  // A store is only written once it CHANGES, and persistence is attached after
  // seeding — so a session that never touched the team, then died without a
  // pagehide flush, leaves `gn:team` absent while projects/orders/scope are
  // present. Restore then succeeds and the team store keeps its module-initial
  // empty value, which makes `activeMember()` undefined and every capability
  // check pass. An old save silently turned the permission gate off.
  if (teamStore.get().members.allIds.length === 0) {
    teamStore.set({
      members: collectionFrom(SEED_TEAM),
      activeId: SEED_TEAM[0]?.id ?? null,
    });
  }
  if (paymentMethodsStore.get().allIds.length === 0) {
    paymentMethodsStore.set(collectionFrom(SEED_PAYMENT_METHODS));
  }

  return true;
}

/** Demo Reset: wipe everything and rebuild from the scenario. */
export function resetDemo(seed?: number): void {
  clearPersistedState();
  boot({ reset: true, ...(seed !== undefined ? { seed } : {}) });
}
