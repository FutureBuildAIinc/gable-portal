// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { newId } from '../lib/ids';
import type { SimClock } from './clock';

/**
 * A persisted queue of future supplier work.
 *
 * Persisted rather than held in memory because the whole point is that the
 * world keeps turning: close the tab mid-quote, come back tomorrow, and the
 * quote is waiting for you. On boot, everything already due runs immediately
 * in order, which gives "it happened while you were away" for free.
 */

export interface SimTask {
  id: string;
  /** Sim-time epoch ms. */
  dueAt: number;
  type: string;
  payload: Record<string, unknown>;
}

export type TaskHandler = (payload: Record<string, unknown>, task: SimTask) => void;

export interface Scheduler {
  schedule(type: string, delayMs: number, payload?: Record<string, unknown>): SimTask;
  scheduleAt(type: string, dueAt: number, payload?: Record<string, unknown>): SimTask;
  cancelWhere(predicate: (task: SimTask) => boolean): number;
  on(type: string, handler: TaskHandler): void;
  /** Runs everything due now. Returns how many tasks fired. */
  pump(): number;
  /** Sim time of the next pending task, or null when the world is idle. */
  nextDueAt(): number | null;
  tasks(): SimTask[];
  start(): void;
  stop(): void;
}

export interface SchedulerHost {
  clock: SimClock;
  getTasks(): SimTask[];
  setTasks(tasks: SimTask[]): void;
}

export function createScheduler(host: SchedulerHost): Scheduler {
  const handlers = new Map<string, TaskHandler>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  function schedule(type: string, delayMs: number, payload: Record<string, unknown> = {}): SimTask {
    return scheduleAt(type, host.clock.now() + delayMs, payload);
  }

  function scheduleAt(type: string, dueAt: number, payload: Record<string, unknown> = {}): SimTask {
    const task: SimTask = { id: newId('task'), dueAt, type, payload };
    host.setTasks([...host.getTasks(), task]);
    return task;
  }

  function pump(): number {
    // Guard against a handler that schedules something already due, which
    // would otherwise spin this loop forever.
    let fired = 0;
    for (let pass = 0; pass < 50; pass++) {
      const now = host.clock.now();
      const due = host
        .getTasks()
        .filter((task) => task.dueAt <= now)
        // Strict dueAt order keeps a catch-up replay deterministic.
        .sort((a, b) => a.dueAt - b.dueAt);

      if (due.length === 0) break;

      for (const task of due) {
        // A handler earlier in this pass may have cancelled this task
        // (withdraw, reschedule) — honour that instead of the stale snapshot.
        const live = host.getTasks();
        if (!live.some((pending) => pending.id === task.id)) continue;

        // Remove exactly this task before running it, so a throwing handler
        // costs only its own task — batch-deleting up front meant one bad
        // handler silently discarded every sibling due in the same pass.
        host.setTasks(live.filter((pending) => pending.id !== task.id));

        const handler = handlers.get(task.type);
        if (!handler) {
          console.error(`[sim] no handler for task type "${task.type}" — task dropped`, task);
          fired++;
          continue;
        }
        try {
          handler(task.payload, task);
        } catch (error) {
          console.error(`[sim] task "${task.type}" (${task.id}) threw and was dropped`, error);
        }
        fired++;
      }
    }
    return fired;
  }

  return {
    schedule,
    scheduleAt,

    cancelWhere(predicate) {
      const all = host.getTasks();
      const kept = all.filter((task) => !predicate(task));
      host.setTasks(kept);
      return all.length - kept.length;
    },

    on(type, handler) {
      handlers.set(type, handler);
    },

    pump,

    nextDueAt() {
      const pending = host.getTasks();
      if (pending.length === 0) return null;
      return pending.reduce((min, task) => Math.min(min, task.dueAt), Number.POSITIVE_INFINITY);
    },

    tasks: () => host.getTasks(),

    start() {
      if (running) return;
      running = true;
      pump(); // catch up on anything that came due while the tab was closed
      timer = setInterval(pump, 250);
    },

    stop() {
      running = false;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
