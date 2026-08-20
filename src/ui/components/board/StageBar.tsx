// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { ORDER_STAGES, type OrderStage, STAGE_LABELS } from '@core/domain/project';
import { formatCentsCompact } from '@core/lib/money';
import type { StageColumn } from '@core/selectors/board';
import { cn } from '@ui/lib/cn';
import { STAGE_VAR } from './stageStyles';

/**
 * The mobile answer to a four-column kanban: show one stage at a time and make
 * the bar the way you move between them. Four columns on a 390px screen means
 * ~90px per card, which is unreadable — so the columns become tabs.
 *
 * During a drag the same bar doubles as the drop-target row, which is why
 * `dropTargets` exists: it is how a card crosses stages without a horizontal
 * scroll.
 */

interface Props {
  columns: StageColumn[];
  active: OrderStage;
  onSelect: (stage: OrderStage) => void;
  /** When dragging, only these stages accept the card. */
  dropTargets?: OrderStage[] | null | undefined;
  hoveredTarget?: OrderStage | null | undefined;
}

export function StageBar({ columns, active, onSelect, dropTargets, hoveredTarget }: Props) {
  const dragging = dropTargets != null;

  return (
    <div className="flex gap-1 px-3 py-2" role="tablist" aria-label="Board stage">
      {ORDER_STAGES.map((stage) => {
        const column = columns.find((c) => c.stage === stage);
        const count = column?.cards.length ?? 0;
        const isActive = stage === active;
        const isTarget = dragging && dropTargets?.includes(stage);
        const isHovered = hoveredTarget === stage;

        return (
          <button
            key={stage}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-stage={stage}
            onClick={() => onSelect(stage)}
            className={cn(
              'relative flex-1 rounded-lg px-1 py-2 text-center transition-all',
              'min-h-11',
              // Dimmed, not hidden: these still accept a drop and will explain
              // why the move isn't allowed.
              dragging && !isTarget && 'opacity-45',
              isTarget && 'ring-2 ring-offset-1',
              isHovered && 'scale-105',
              !dragging && isActive && 'bg-surface-3',
            )}
            style={
              isTarget
                ? ({
                    '--tw-ring-color': STAGE_VAR[stage],
                  } as React.CSSProperties)
                : undefined
            }
          >
            <span
              aria-hidden
              className="mx-auto mb-1 block h-1 w-6 rounded-full transition-opacity"
              style={{
                background: STAGE_VAR[stage],
                opacity: isActive || isTarget ? 1 : 0.3,
              }}
            />
            <span
              className={cn(
                'block text-[12px] font-medium leading-tight',
                isActive ? 'text-text' : 'text-text-muted',
              )}
            >
              {STAGE_LABELS[stage]}
            </span>
            <span className="mt-0.5 block text-[10.5px] leading-tight text-text-subtle">
              {count === 0 ? '—' : `${count} · ${formatCentsCompact(column?.total ?? 0)}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
