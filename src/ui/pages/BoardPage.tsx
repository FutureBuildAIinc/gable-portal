// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { moveOrderToStage } from '@core/actions/orders';
import { requireCapability } from '@core/actions/team';
import { getContext } from '@core/boot';
import type { OrderStage } from '@core/domain/project';
import { canMoveToStage } from '@core/domain/stage';
import { formatCents } from '@core/lib/money';
import { type BoardCard, buildBoardCards, groupByStage } from '@core/selectors/board';
import {
  ordersStore,
  projectsStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
} from '@core/stores/root';
import { listOf } from '@core/stores/store';
import { Board } from '@ui/components/board/Board';
import { StageTransitionSheet } from '@ui/components/board/StageTransitionSheet';
import { useStore } from '@ui/hooks/useStore';
import { useMemo, useState } from 'react';

interface PendingMove {
  card: BoardCard;
  target: OrderStage;
  blockedReason: string | null;
}

export function BoardPage({ onOpenOrder }: { onOpenOrder: (orderId: string) => void }) {
  const orders = useStore(ordersStore, (state) => state);
  const projects = useStore(projectsStore, (state) => state);
  const scope = useStore(scopeStore, (state) => state);
  const quotes = useStore(quotesStore, (state) => state);
  const salesOrders = useStore(salesOrdersStore, (state) => state);

  const [activeStage, setActiveStage] = useState<OrderStage>('plan');
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const now = getContext().clock.nowIso();

  const columns = useMemo(
    () => groupByStage(buildBoardCards(orders, projects, scope, quotes, salesOrders, now)),
    [orders, projects, scope, quotes, salesOrders, now],
  );

  const pipeline = columns.reduce((sum, column) => sum + column.total, 0);
  const openCount = columns
    .filter((column) => column.stage !== 'invoice')
    .reduce((sum, column) => sum + column.cards.length, 0);

  /**
   * A drop asks the stage machine first. If it refuses, the sheet still opens —
   * showing the reason — because silently snapping a card back teaches the
   * contractor nothing about why the move was wrong.
   */
  function requestMove(card: BoardCard, target: OrderStage) {
    // Permission first: the stage machine explains WHAT can't happen; the
    // team gate explains WHO can't do it. Same sheet either way.
    const permitted = requireCapability('move-stage');
    if (!permitted.ok) {
      setPending({ card, target, blockedReason: permitted.error });
      return;
    }

    const items = listOf(scope).filter((item) => item.orderId === card.order.id);
    const decision = canMoveToStage(card.order, target, {
      items,
      now,
      supplierStatus: card.order.salesOrderId
        ? salesOrders.byId[card.order.salesOrderId]?.status
        : undefined,
    });
    setPending({
      card,
      target,
      blockedReason: decision.ok ? null : decision.error,
    });
  }

  function confirmMove() {
    if (!pending) return;
    const result = moveOrderToStage(pending.card.order.id, pending.target);
    if (result.ok) {
      setActiveStage(pending.target);
      setToast(`${pending.card.order.name} moved to ${pending.target}`);
      setTimeout(() => setToast(null), 2600);
    } else {
      setToast(result.error);
      setTimeout(() => setToast(null), 4000);
    }
    setPending(null);
  }

  return (
    <>
      <div className="border-b border-border bg-surface px-4 py-2.5 lg:px-6">
        <p className="text-[12px] text-text-muted">
          <span className="font-semibold text-text">{formatCents(pipeline)}</span> in pipeline ·{' '}
          {openCount} open order{openCount === 1 ? '' : 's'}
        </p>
      </div>

      <Board
        columns={columns}
        now={now}
        activeStage={activeStage}
        onStageChange={setActiveStage}
        onRequestMove={requestMove}
        onOpenOrder={onOpenOrder}
      />

      <StageTransitionSheet
        card={pending?.card ?? null}
        target={pending?.target ?? null}
        blockedReason={pending?.blockedReason ?? null}
        onConfirm={confirmMove}
        onCancel={() => setPending(null)}
        onRedirect={(target) => {
          if (pending) requestMove(pending.card, target);
        }}
      />

      {toast ? (
        <output className="fixed inset-x-4 bottom-24 z-40 block rounded-lg bg-text px-4 py-3 text-sm text-surface shadow-[var(--shadow-lifted)] lg:inset-x-auto lg:right-6 lg:bottom-6 lg:max-w-sm">
          {toast}
        </output>
      ) : null}
    </>
  );
}
