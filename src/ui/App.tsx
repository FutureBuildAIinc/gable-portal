// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { boot } from '@core/boot';
import { initGableConnection } from '@core/gable/connect';
import { isGableWired } from '@core/gable/runtime';
import { gableStore } from '@core/gable/store';
import { clearPersistedState } from '@core/stores/persistence';
import { sessionStore } from '@core/stores/root';
import { ActivitySheet } from '@ui/components/ActivitySheet';
import { DemoDirector } from '@ui/components/DemoDirector';
import { AssistantSheet } from '@ui/components/assistant/AssistantSheet';
import { SignInPage } from '@ui/components/gable/SignInPage';
import { useStore } from '@ui/hooks/useStore';
import { PortalLayout, type PortalTab } from '@ui/layouts/PortalLayout';
import { BoardPage } from '@ui/pages/BoardPage';
import { CatalogPage } from '@ui/pages/CatalogPage';
import { CustomerQuotePage } from '@ui/pages/CustomerQuotePage';
import { OrderPage } from '@ui/pages/OrderPage';
import { OrderTrackingPage } from '@ui/pages/OrderTrackingPage';
import { PayPage } from '@ui/pages/PayPage';
import { ProjectPage } from '@ui/pages/ProjectPage';
import { QuoteStudioPage } from '@ui/pages/QuoteStudioPage';
import { TeamPage } from '@ui/pages/TeamPage';
import { type ReactNode, useEffect, useState } from 'react';
import {
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
  useNavigate,
  useParams,
} from 'react-router';

// Wire the core once, before first render. If a poisoned save makes boot
// itself throw, wipe and reseed rather than white-screening forever — the
// stored state that caused the crash would otherwise crash every reload too.
try {
  boot();
} catch (error) {
  console.error('[app] boot failed — clearing saved state and reseeding', error);
  clearPersistedState();
  boot({ reset: true });
}

/**
 * Establishes the ERP link once, for the whole app.
 *
 * Outside the router on purpose: a reload onto `/orders/:id` has to connect the
 * same way a reload onto `/` does, and hanging this off a route would reconnect
 * on every navigation.
 *
 * `boot()` above has already run and seeded the simulator. That ordering is
 * deliberate — the app is usable in the frame before the network answers, and a
 * `gable` that never answers degrades to a sign-in prompt rather than a blank
 * screen.
 */
function useGableConnection() {
  useEffect(() => {
    void initGableConnection();
  }, []);
}

/**
 * The sign-in gate.
 *
 * Only ever renders on a wired deployment: standalone has nothing to sign in
 * to, so the whole notion of being signed out does not exist there. `'error'`
 * deliberately falls through to the app rather than blocking it — an
 * unreachable ERP should leave the contractor looking at the board with an
 * honest "Supplier unreachable" badge, not at a wall.
 */
function GableGate({ children }: { children: ReactNode }) {
  const status = useStore(gableStore, (state) => state.status);
  if (isGableWired() && status === 'signed-out') return <SignInPage />;
  return <>{children}</>;
}

/**
 * Real routes rather than view state, because on a phone the hardware back
 * button has to work: opening an order and pressing back must return to the
 * board, not exit the app. It also gives M5's customer share link (/q/:token)
 * somewhere to live.
 */
export function App() {
  useGableConnection();

  return (
    <Router>
      <Routes>
        <Route path="/" element={<GatedShell />} />
        <Route path="/orders/:orderId" element={<GatedShell />} />
        <Route path="/orders/:orderId/quote" element={<GatedShell />} />
        <Route path="/orders/:orderId/tracking" element={<GatedShell />} />
        {/* Public: the homeowner's link. No portal chrome, no auth — and
            deliberately NOT behind the ERP gate: the person opening it is the
            contractor's customer, who has no account with the dealer at all. */}
        <Route path="/q/:token" element={<PublicQuote />} />
        <Route path="/projects/:projectId" element={<GatedShell />} />
        <Route path="/catalog" element={<GatedShell />} />
        <Route path="/pay" element={<GatedShell />} />
        <Route path="/more" element={<GatedShell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

function GatedShell() {
  return (
    <GableGate>
      <Shell />
    </GableGate>
  );
}

function Shell() {
  const navigate = useNavigate();
  const params = useParams();
  const account = useStore(sessionStore, (state) => state.account);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  // Asked once at boot so the assistant can render an honest disabled state
  // instead of failing on first use. The assistant is usable if EITHER the
  // server holds a key or the contractor pasted their own, so the health
  // answer is kept separate and OR-ed with local state.
  const [serverHasKey, setServerHasKey] = useState<boolean | null>(null);
  // Subscribed, so a key added or removed from EITHER key sheet (the
  // assistant's or the More page's) re-gates the assistant immediately.

  useEffect(() => {
    // A hung dev server must not leave the assistant stuck on "checking"
    // forever — fall back to whatever key the browser already has.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);

    fetch('/api/anthropic/health', { signal: abort.signal })
      .then((response) => response.json())
      .then((body) => setServerHasKey(Boolean(body?.hasKey)))
      .catch(() => setServerHasKey(false))
      .finally(() => clearTimeout(timeout));

    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, []);

  const hasKey =
    // The dealer owns the key now, so the server's answer IS the answer.
    serverHasKey === null ? null : serverHasKey === true;

  const path = window.location.pathname;
  const orderId = params.orderId;
  const projectId = params.projectId;
  const isQuoteStudio = path.endsWith('/quote');
  const isTracking = path.endsWith('/tracking');

  const tab: PortalTab = path.startsWith('/catalog')
    ? 'catalog'
    : path.startsWith('/pay')
      ? 'pay'
      : path.startsWith('/more')
        ? 'more'
        : 'board';

  const heading = orderId
    ? { title: 'Order', subtitle: undefined }
    : projectId
      ? { title: 'Project', subtitle: undefined }
      : tab === 'board'
        ? { title: 'Procurement Board', subtitle: account?.name }
        : {
            title: tab === 'catalog' ? 'Catalog' : tab === 'pay' ? 'Pay' : 'Team',
            subtitle: undefined,
          };

  return (
    <>
      <PortalLayout
        tab={tab}
        onTabChange={(next) => navigate(next === 'board' ? '/' : `/${next}`)}
        onOpenAssistant={() => setAssistantOpen(true)}
        onOpenActivity={() => setActivityOpen(true)}
        onOpenDemo={() => setDemoOpen(true)}
        title={heading.title}
        subtitle={heading.subtitle}
        hideChrome={Boolean(orderId || projectId)}
      >
        {orderId && isQuoteStudio ? (
          <QuoteStudioPage orderId={orderId} onBack={() => navigate(`/orders/${orderId}`)} />
        ) : orderId && isTracking ? (
          <OrderTrackingPage orderId={orderId} onBack={() => navigate(`/orders/${orderId}`)} />
        ) : orderId ? (
          <OrderPage
            orderId={orderId}
            onBack={() => navigate('/')}
            onOpenProject={(id) => navigate(`/projects/${id}`)}
            onOpenQuote={() => navigate(`/orders/${orderId}/quote`)}
            onOpenTracking={() => navigate(`/orders/${orderId}/tracking`)}
          />
        ) : projectId ? (
          <ProjectPage
            projectId={projectId}
            onBack={() => navigate('/')}
            onOpenOrder={(id) => navigate(`/orders/${id}`)}
          />
        ) : tab === 'board' ? (
          <BoardPage onOpenOrder={(id) => navigate(`/orders/${id}`)} />
        ) : tab === 'pay' ? (
          <PayPage onOpenOrder={(id) => navigate(`/orders/${id}`)} />
        ) : tab === 'more' ? (
          <TeamPage />
        ) : (
          <CatalogPage onOpenOrder={(id) => navigate(`/orders/${id}`)} />
        )}
      </PortalLayout>

      <ActivitySheet open={activityOpen} onOpenChange={setActivityOpen} />
      <DemoDirector open={demoOpen} onOpenChange={setDemoOpen} />

      <AssistantSheet
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        hasKey={hasKey}
      />
    </>
  );
}

function PublicQuote() {
  const params = useParams();
  return <CustomerQuotePage token={params.token ?? ''} />;
}
