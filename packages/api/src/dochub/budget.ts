import type { DochubLimits } from './types';
import { DochubError } from './errors';

/**
 * Bounds one tool call. A research call may legitimately read a whole document,
 * so the limits are generous — but they must be finite, and hitting one has to
 * produce a partial answer rather than an error: `reduceReserveMs` is the time
 * kept aside so the sub-agent can still summarise what it managed to read.
 */
export interface RunBudget {
  /** Aborts on the wall clock or when the caller's own signal aborts. */
  readonly signal: AbortSignal;
  chargeHttp(): void;
  chargeLlm(): void;
  remainingMs(): number;
  /** True once only the reduce step should still be attempted. */
  inReduceWindow(): boolean;
  exhausted(): { http: boolean; llm: boolean; time: boolean };
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

const budgetError = (message: string): DochubError =>
  new DochubError({ kind: 'budget', message, retryable: false });

export function createRunBudget(options: RunBudgetOptions): RunBudget {
  const { limits, parentSignal } = options;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), limits.wallClockMs);
  /** Never keep the process alive for a budget timer. */
  timer.unref?.();

  let httpCalls = 0;
  let llmCalls = 0;
  const collected: string[] = [];

  const elapsed = () => now() - startedAt;
  const remainingMs = () => Math.max(0, limits.wallClockMs - elapsed());

  const note = (message: string) => {
    if (!collected.includes(message)) {
      collected.push(message);
    }
  };

  return {
    signal: controller.signal,
    remainingMs,
    inReduceWindow: () => remainingMs() <= limits.reduceReserveMs,
    exhausted: () => ({
      http: httpCalls >= limits.maxHttpRequests,
      llm: llmCalls >= limits.maxLlmCalls,
      time: remainingMs() <= 0,
    }),
    chargeHttp: () => {
      if (httpCalls >= limits.maxHttpRequests) {
        note(
          `⚠ Исчерпан лимит обращений к DocHub за один вызов (${limits.maxHttpRequests}). Результат неполный.`,
        );
        throw budgetError(`DocHub HTTP budget exhausted (${limits.maxHttpRequests})`);
      }
      httpCalls += 1;
    },
    chargeLlm: () => {
      if (llmCalls >= limits.maxLlmCalls) {
        note(
          `⚠ Исчерпан лимит разборов текста за один вызов (${limits.maxLlmCalls}). Результат неполный.`,
        );
        throw budgetError(`DocHub LLM budget exhausted (${limits.maxLlmCalls})`);
      }
      llmCalls += 1;
    },
    note,
    notes: () => [...collected],
    spent: () => ({ http: httpCalls, llm: llmCalls, elapsedMs: elapsed() }),
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
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
