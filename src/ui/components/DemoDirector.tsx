// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext, resetDemo } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import { formatDateTime } from '@core/lib/time';
import { CLOCK_SPEEDS, SPEED_LABELS } from '@core/sim/config';
import { simStore } from '@core/stores/root';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import { FastForward, Gauge, RotateCcw, SkipForward } from 'lucide-react';
import { useState } from 'react';

/**
 * Demo controls.
 *
 * A supplier that takes five hours to price a quote is believable but
 * unwatchable, so this exists to compress time without making the simulation
 * lie: the delays stay realistic and the clock moves faster.
 *
 * "Skip to next event" is the one that carries a demo. Rather than guessing a
 * speed, it jumps straight to the moment the next thing happens — whether that
 * is twenty minutes or nine days away.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DemoDirector({ open, onOpenChange }: Props) {
  const sim = useStore(simStore, (state) => state);
  const [, force] = useState(0);
  const [armed, setArmed] = useState(false);
  const { clock, sim: engine } = getContext();

  const nextDue = engine.control.nextDueAt();
  const pending = sim.tasks.length;

  function refresh() {
    force((n) => n + 1);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Demo controls"
      description={`${supplierName()} works at realistic speeds. Move the clock instead.`}
    >
      <div className="space-y-5">
        <section>
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-muted">
            <Gauge size={13} strokeWidth={2} />
            Clock speed
          </p>
          <div className="flex gap-1 rounded-lg bg-surface-inset p-1">
            {CLOCK_SPEEDS.map((speed) => (
              <button
                key={speed}
                type="button"
                onClick={() => {
                  engine.control.setSpeed(speed);
                  refresh();
                }}
                className={
                  clock.speed() === speed
                    ? 'min-h-9 flex-1 rounded-md bg-surface text-[11.5px] font-medium shadow-[var(--shadow-card)]'
                    : 'min-h-9 flex-1 rounded-md text-[11.5px] text-text-muted'
                }
              >
                {SPEED_LABELS[speed]}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <Button
            full
            variant="secondary"
            disabled={nextDue === null}
            onClick={() => {
              engine.control.skipToNextEvent();
              refresh();
            }}
          >
            <SkipForward size={16} strokeWidth={2} />
            {nextDue === null ? 'Nothing pending' : 'Skip to next event'}
          </Button>

          <Button
            full
            variant="outline"
            onClick={() => {
              engine.control.advanceDays(1);
              refresh();
            }}
          >
            <FastForward size={16} strokeWidth={2} />
            Skip a day
          </Button>
        </section>

        <dl className="space-y-1.5 rounded-lg bg-surface-inset p-3 text-[12.5px]">
          <div className="flex justify-between">
            <dt className="text-text-muted">Supplier time</dt>
            <dd className="tabular-nums">{formatDateTime(clock.nowIso())}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Work in progress</dt>
            <dd>
              {pending === 0 ? 'nothing pending' : `${pending} step${pending === 1 ? '' : 's'}`}
            </dd>
          </div>
          {nextDue !== null ? (
            <div className="flex justify-between">
              <dt className="text-text-muted">Next event</dt>
              <dd className="tabular-nums">{formatDateTime(new Date(nextDue).toISOString())}</dd>
            </div>
          ) : null}
        </dl>

        <section>
          {/* Two taps, because one glove-brush wiping the whole demo mid-walkthrough
              is not a recoverable mistake. */}
          <Button
            full
            variant={armed ? 'danger' : 'outline'}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                setTimeout(() => setArmed(false), 4000);
                return;
              }
              resetDemo();
              setArmed(false);
              onOpenChange(false);
            }}
          >
            <RotateCcw size={16} strokeWidth={2} />
            {armed ? 'Tap again to wipe everything' : 'Reset the demo'}
          </Button>
          <p className="mt-2 text-[11.5px] text-text-subtle">
            Wipes everything and reseeds the same eight orders. The same seed always produces the
            same quotes and delivery times.
          </p>
        </section>
      </div>
    </Sheet>
  );
}
