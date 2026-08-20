// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import { formatDateTime, formatRelativeDays } from '@core/lib/time';
import { activityStore } from '@core/stores/root';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import { Building2, Sparkles, User } from 'lucide-react';
import { useEffect } from 'react';

/**
 * What the supplier did while you weren't looking.
 *
 * This is the only notification channel — deliberately. Sim events are frequent
 * at speed, and toasting each one would make the app feel like it was shouting.
 * They accumulate here behind a count, and opening the sheet marks them read.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ActivitySheet({ open, onOpenChange }: Props) {
  const activity = useStore(activityStore, (state) => state);
  const { clock } = getContext();

  // Opening it is the read receipt.
  useEffect(() => {
    if (!open) return;
    activityStore.set({ ...activityStore.get(), readWatermark: clock.nowIso() });
  }, [open, clock]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Activity"
      description={`Everything you and ${supplierName()} have done.`}
    >
      {activity.entries.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-subtle">
          Nothing yet. Send an order to the quote desk and {supplierName()} will get to work.
        </p>
      ) : (
        <ol className="space-y-0.5">
          {activity.entries.map((entry) => (
            <li key={entry.id} className="flex gap-3 py-2.5">
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                style={{
                  background:
                    entry.actor === 'system'
                      ? 'color-mix(in oklch, var(--info), transparent 86%)'
                      : 'var(--surface-3)',
                  color: entry.actor === 'system' ? 'var(--info)' : 'var(--text-muted)',
                }}
              >
                {entry.actor === 'system' ? (
                  <Building2 size={14} strokeWidth={2} />
                ) : entry.actor === 'assistant' ? (
                  <Sparkles size={14} strokeWidth={2} />
                ) : (
                  <User size={14} strokeWidth={2} />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-[13px] leading-snug">{entry.message}</p>
                <p className="mt-0.5 text-[11px] text-text-subtle">
                  {formatDateTime(entry.at)} · {formatRelativeDays(clock.nowIso(), entry.at)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
