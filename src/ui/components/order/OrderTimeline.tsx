// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { formatDateTime } from '@core/lib/time';
import type { TrackingStep } from '@core/selectors/tracking';
import { cn } from '@ui/lib/cn';
import { Check } from 'lucide-react';

/**
 * The vertical fulfillment timeline.
 *
 * Every step of the journey is rendered, not just the ones that have happened,
 * because the question on a job site is "when does it get here", and a list of
 * completed events can't answer that. Done steps are filled and dated, the
 * current step is the only one carrying live colour, and what's left is muted —
 * so the eye lands on "where is it now" before reading anything.
 */

const DONE_RAIL = 'color-mix(in oklch, var(--success), transparent 45%)';

interface Props {
  steps: readonly TrackingStep[];
  /** A cancelled order stops rather than continuing to promise steps. */
  cancelled?: boolean | undefined;
}

export function OrderTimeline({ steps, cancelled }: Props) {
  return (
    <ol className="relative">
      {steps.map((step, index) => {
        const done = step.state === 'done';
        const current = step.state === 'current' && !cancelled;
        const reached = done || current;
        const last = index === steps.length - 1;

        return (
          <li key={step.status} className="flex gap-3">
            {/* Node and rail share a fixed 22px gutter so the text column
                stays aligned all the way down, even at 375px. */}
            <div className="flex w-[22px] shrink-0 flex-col items-center">
              <span
                className={cn(
                  'mt-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2',
                  reached ? 'border-transparent text-on-signal' : 'border-border-strong bg-surface',
                )}
                style={
                  reached ? { background: current ? 'var(--info)' : 'var(--success)' } : undefined
                }
              >
                {done ? <Check size={13} strokeWidth={3} /> : null}
                {current ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
              </span>
              {!last ? (
                <span
                  aria-hidden
                  className="w-0.5 flex-1 bg-border"
                  style={done ? { background: DONE_RAIL } : undefined}
                />
              ) : null}
            </div>

            <div className={cn('min-w-0 flex-1', last ? 'pb-0' : 'pb-5')}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p
                  className={cn(
                    'text-[14px] leading-tight',
                    current && 'font-semibold',
                    done && 'font-medium',
                    !reached && 'text-text-subtle',
                  )}
                >
                  {step.label}
                </p>
                {step.at ? (
                  <time
                    dateTime={step.at}
                    className="shrink-0 text-[11.5px] tabular-nums text-text-subtle"
                  >
                    {formatDateTime(step.at)}
                  </time>
                ) : null}
              </div>
              {step.note ? (
                <p
                  className={cn(
                    'mt-0.5 text-[12.5px] leading-snug',
                    current ? 'text-text-muted' : 'text-text-subtle',
                  )}
                >
                  {step.note}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
