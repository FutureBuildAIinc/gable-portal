// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '@core/boot';
import { ORDER_STAGES, STAGE_LABELS } from '@core/domain/project';
import { formatCents } from '@core/lib/money';
import { buildBoardCards, cardsForProject } from '@core/selectors/board';
import {
  ordersStore,
  projectsStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
} from '@core/stores/root';
import { OrderCard } from '@ui/components/board/OrderCard';
import { STAGE_VAR } from '@ui/components/board/stageStyles';
import { useStore } from '@ui/hooks/useStore';
import { ChevronLeft, MapPin } from 'lucide-react';
import { useMemo } from 'react';

/**
 * The drill-down: one project, its orders grouped by the stage each one is in.
 *
 * This is the counterpart to the board. The board answers "what needs me next?"
 * across every job; this answers "where does the Wilson house stand?" — which is
 * how a contractor talks about their work, and the reason splitting a job into
 * per-order cards doesn't lose the job as a unit.
 */

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenOrder: (orderId: string) => void;
}

export function ProjectPage({ projectId, onBack, onOpenOrder }: Props) {
  const orders = useStore(ordersStore, (state) => state);
  const projects = useStore(projectsStore, (state) => state);
  const scope = useStore(scopeStore, (state) => state);
  const quotes = useStore(quotesStore, (state) => state);
  const salesOrders = useStore(salesOrdersStore, (state) => state);
  const now = getContext().clock.nowIso();

  const cards = useMemo(
    () =>
      cardsForProject(
        buildBoardCards(orders, projects, scope, quotes, salesOrders, now),
        projectId,
      ),
    [orders, projects, scope, quotes, salesOrders, projectId, now],
  );

  const project = projects.byId[projectId];
  if (!project) {
    return (
      <div className="p-8 text-center text-sm text-text-subtle">
        That project no longer exists.{' '}
        <button type="button" onClick={onBack} className="text-brand underline">
          Back to the board
        </button>
      </div>
    );
  }

  const total = cards.reduce((sum, card) => sum + card.totals.subtotal, 0);

  return (
    <>
      <header className="border-b border-border bg-surface px-4 py-3 lg:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 mb-1.5 inline-flex min-h-9 items-center gap-1 text-[12.5px] text-text-muted hover:text-text"
        >
          <ChevronLeft size={15} strokeWidth={2.5} />
          Board
        </button>

        <h2 className="text-[19px] font-semibold tracking-tight">{project.name}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-text-muted">
          {project.clientName ? <span>{project.clientName}</span> : null}
          {project.address ? (
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} strokeWidth={2} />
              {project.address.city}, {project.address.state}
            </span>
          ) : null}
        </div>

        <p className="mt-3 text-[13px] text-text-muted">
          <span className="font-semibold text-text">{formatCents(total)}</span> across{' '}
          {cards.length} order{cards.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="space-y-5 p-4 pb-28 lg:px-6">
        {ORDER_STAGES.map((stage) => {
          const inStage = cards.filter((card) => card.order.stage === stage);
          if (inStage.length === 0) return null;

          return (
            <section key={stage}>
              <h3 className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-text-muted">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ background: STAGE_VAR[stage] }}
                />
                {STAGE_LABELS[stage]}
                <span className="font-normal text-text-subtle">
                  {formatCents(inStage.reduce((sum, card) => sum + card.totals.subtotal, 0))}
                </span>
              </h3>

              <div className="space-y-2.5">
                {inStage.map((card) => (
                  <OrderCard key={card.order.id} card={card} now={now} onOpen={onOpenOrder} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
