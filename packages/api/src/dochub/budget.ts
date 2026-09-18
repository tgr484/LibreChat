import type { DochubLimits } from './types';
import { DochubError } from './errors';

/**
 * Two phases of one tool call. `work` is reading and extracting; `reduce` is
 * condensing what was read. Work stops `reserveMs` before the deadline so the
 * reduce steps always get their time, however long a single extraction takes.
 */
export type DochubPhase = 'work' | 'reduce';

/**
 * Reduce calls may go past `maxLlmCalls` by this much: a run that spent its
 * counter on extraction must still be able to condense it (one reduce per
 * survey document plus the survey's own).
 */
export const REDUCE_LLM_ALLOWANCE = 16;

/**
 * Bounds one tool call. A research call may legitimately read a whole document,
 * so the limits are generous — but they must be finite, and hitting one has to
 * produce a partial answer rather than an error.
 */
export interface RunBudget {
  readonly limits: DochubLimits;
  /** Aborts at the deadline or when the caller's own signal aborts. */
  readonly signal: AbortSignal;
  /** Aborts when the work phase ends; in-flight extractions stop with it. */
  readonly workSignal: AbortSignal;
  chargeHttp(): void;
  chargeLlm(phase?: DochubPhase): void;
  remainingMs(): number;
  /** Time left for work, i.e. before the reduce reserve starts. */
  workRemainingMs(): number;
  /** True once only the reduce step should still be attempted. */
  inReduceWindow(): boolean;
  exhausted(): { http: boolean; llm: boolean; time: boolean };
  /** `aborted` when the user stopped the run, `budget` when a limit did. */
  stopKind(): 'aborted' | 'budget';
  /**
   * A share of this budget with its own, earlier deadline and reserve. Counters
   * and notes stay shared; the slice always ends before this budget's reserve,
   * so this budget's own reduce keeps its time.
   */
  slice(options: { durationMs: number; reserveMs: number }): RunBudget;
  /** Russian notice for the calling model; repeats are collapsed. */
  note(message: string): void;
  notes(): string[];
  spent(): { http: number; llm: number; elapsedMs: number };
  dispose(): void;
}

export interface RunBudgetOptions {
  limits: DochubLimits;
  parentSignal?: AbortSignal;
  /** Injected in tests so the clock is not the thing under test. */
  now?: () => number;
}

interface SharedState {
  limits: DochubLimits;
  now: () => number;
  startedAt: number;
  parentSignal?: AbortSignal;
  http: number;
  llm: number;
  notes: string[];
}

const budgetError = (message: string): DochubError =>
  new DochubError({ kind: 'budget', message, retryable: false });

/** Aborts `controller` after `delayMs` or with `source`; returns the cleanup. */
function linkAbort(
  controller: AbortController,
  delayMs: number,
  source: AbortSignal | undefined,
): () => void {
  const abort = () => controller.abort(source?.reason);
  if (source?.aborted) {
    abort();
  } else {
    source?.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(0, delayMs));
  /** Never keep the process alive for a budget timer. */
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    source?.removeEventListener('abort', abort);
  };
}

function createView(
  shared: SharedState,
  deadline: number,
  reserveMs: number,
  parent: AbortSignal | undefined,
): RunBudget {
  const { limits, now } = shared;
  const remainingMs = () => Math.max(0, deadline - now());
  const workRemainingMs = () => Math.max(0, deadline - reserveMs - now());

  const hard = new AbortController();
  const work = new AbortController();
  const cleanups = [
    linkAbort(hard, remainingMs(), parent),
    linkAbort(work, workRemainingMs(), hard.signal),
  ];
  const slices: RunBudget[] = [];

  const note = (message: string) => {
    if (!shared.notes.includes(message)) {
      shared.notes.push(message);
    }
  };

  return {
    limits,
    signal: hard.signal,
    workSignal: work.signal,
    remainingMs,
    workRemainingMs,
    inReduceWindow: () => workRemainingMs() <= 0,
    exhausted: () => ({
      http: shared.http >= limits.maxHttpRequests,
      llm: shared.llm >= limits.maxLlmCalls,
      time: remainingMs() <= 0,
    }),
    stopKind: () => (shared.parentSignal?.aborted ? 'aborted' : 'budget'),
    chargeHttp: () => {
      if (shared.http >= limits.maxHttpRequests) {
        note(
          `⚠ Исчерпан лимит обращений к DocHub за один вызов (${limits.maxHttpRequests}). Результат неполный.`,
        );
        throw budgetError(`DocHub HTTP budget exhausted (${limits.maxHttpRequests})`);
      }
      shared.http += 1;
    },
    chargeLlm: (phase: DochubPhase = 'work') => {
      const cap =
        phase === 'reduce' ? limits.maxLlmCalls + REDUCE_LLM_ALLOWANCE : limits.maxLlmCalls;
      if (shared.llm >= cap) {
        note(
          `⚠ Исчерпан лимит разборов текста за один вызов (${limits.maxLlmCalls}). Результат неполный.`,
        );
        throw budgetError(`DocHub LLM budget exhausted (${limits.maxLlmCalls})`);
      }
      shared.llm += 1;
    },
    slice: (options) => {
      const start = now();
      const end = Math.min(start + Math.max(0, options.durationMs), deadline - reserveMs);
      const reserve = Math.min(options.reserveMs, Math.max(0, (end - start) / 2));
      const child = createView(shared, end, reserve, hard.signal);
      slices.push(child);
      return child;
    },
    note,
    notes: () => [...shared.notes],
    spent: () => ({ http: shared.http, llm: shared.llm, elapsedMs: now() - shared.startedAt }),
    dispose: () => {
      slices.forEach((child) => child.dispose());
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}

export function createRunBudget(options: RunBudgetOptions): RunBudget {
  const now = options.now ?? (() => Date.now());
  const shared: SharedState = {
    limits: options.limits,
    now,
    startedAt: now(),
    parentSignal: options.parentSignal,
    http: 0,
    llm: 0,
    notes: [],
  };
  return createView(
    shared,
    shared.startedAt + options.limits.wallClockMs,
    Math.min(options.limits.reduceReserveMs, options.limits.wallClockMs),
    options.parentSignal,
  );
}

/** Turns an abort of `signal` into the `DochubError` the callers branch on. */
export function stoppedError(budget: RunBudget, what: string): DochubError {
  return budget.stopKind() === 'aborted'
    ? new DochubError({ kind: 'aborted', message: `${what} → aborted`, retryable: false })
    : budgetError(`${what} → stopped by the run budget`);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, keeping the results in
 * input order. A rejection never cancels the siblings — a chapter that failed to
 * load must not lose the chapters that did.
 */
export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  fn: (item: TItem, index: number) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  const results: PromiseSettledResult<TResult>[] = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
