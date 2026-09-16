import type { DochubLimits } from './types';
import { createRunBudget, mapWithConcurrency } from './budget';

const limits = (overrides: Partial<DochubLimits> = {}): DochubLimits => ({
  wallClockMs: 600000,
  reduceReserveMs: 45000,
  maxHttpRequests: 150,
  maxLlmCalls: 80,
  maxChapters: 40,
  maxChapterChars: 30000,
  maxDocuments: 6,
  chapterConcurrency: 4,
  documentConcurrency: 3,
  extractionCharLimit: 1200,
  resultCharLimit: 6000,
  ...overrides,
});

describe('createRunBudget', () => {
  it('counts what a tool call spends', () => {
    const budget = createRunBudget({ limits: limits() });

    budget.chargeHttp();
    budget.chargeHttp();
    budget.chargeLlm();

    expect(budget.spent()).toMatchObject({ http: 2, llm: 1 });
    budget.dispose();
  });

  it('refuses further work once a counter is spent, and says so in Russian', () => {
    const budget = createRunBudget({ limits: limits({ maxHttpRequests: 1, maxLlmCalls: 1 }) });

    budget.chargeHttp();
    budget.chargeLlm();

    expect(() => budget.chargeHttp()).toThrow(/HTTP budget/);
    expect(() => budget.chargeLlm()).toThrow(/LLM budget/);
    expect(budget.exhausted()).toEqual({ http: true, llm: true, time: false });
    expect(budget.notes()).toHaveLength(2);
    expect(budget.notes()[0]).toContain('⚠');
    budget.dispose();
  });

  it('collapses a repeated notice', () => {
    const budget = createRunBudget({ limits: limits() });

    budget.note('⚠ Прочитано не всё.');
    budget.note('⚠ Прочитано не всё.');

    expect(budget.notes()).toEqual(['⚠ Прочитано не всё.']);
    budget.dispose();
  });

  /** The reduce step must still run, otherwise a long read returns nothing at all. */
  it('opens the reduce window before the wall clock runs out', () => {
    let clock = 1_000_000;
    const budget = createRunBudget({
      limits: limits({ wallClockMs: 60000, reduceReserveMs: 10000 }),
      now: () => clock,
    });

    expect(budget.inReduceWindow()).toBe(false);
    clock += 49_999;
    expect(budget.inReduceWindow()).toBe(false);
    clock += 2;
    expect(budget.inReduceWindow()).toBe(true);
    expect(budget.remainingMs()).toBe(9999);

    clock += 100_000;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.exhausted().time).toBe(true);
    budget.dispose();
  });

  it('aborts when the caller aborts', () => {
    const controller = new AbortController();
    const budget = createRunBudget({ limits: limits(), parentSignal: controller.signal });

    expect(budget.signal.aborted).toBe(false);
    controller.abort();
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it('is already aborted when the caller aborted first', () => {
    const controller = new AbortController();
    controller.abort();

    const budget = createRunBudget({ limits: limits(), parentSignal: controller.signal });
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it('aborts on its own wall clock', async () => {
    jest.useFakeTimers();
    const budget = createRunBudget({ limits: limits({ wallClockMs: 1000 }) });

    expect(budget.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1001);
    expect(budget.signal.aborted).toBe(true);

    budget.dispose();
    jest.useRealTimers();
  });
});

describe('mapWithConcurrency', () => {
  it('keeps the input order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return item * 10;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(results.map((result) => (result.status === 'fulfilled' ? result.value : null))).toEqual([
      10, 20, 30, 40, 50, 60, 70,
    ]);
  });

  /** One unreadable chapter must not lose the chapters that did load. */
  it('reports a failure without cancelling its siblings', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) {
        throw new Error('chapter 2 is gone');
      }
      return item;
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('handles an empty list', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
