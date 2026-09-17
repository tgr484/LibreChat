import type {
  DochubContent,
  DochubLimits,
  DochubOutline,
  DochubSearchHit,
  DochubSearchResponse,
} from './types';
import type { DochubClient } from './client';
import type { DochubLlm } from './llm';
import {
  documentChapterCap,
  documentSliceMs,
  formatSurveyResult,
  surveyCollection,
} from './survey';
import { createRunBudget, stoppedError } from './budget';
import { createDochubCatalog } from './catalog';
import { DochubError } from './errors';
import { NO_DATA } from './prompts';

const limits = (overrides: Partial<DochubLimits> = {}): DochubLimits => ({
  wallClockMs: 600000,
  reduceReserveMs: 1000,
  llmCallTimeoutMs: 60000,
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

const hit = (seq: number, canOpen = true, id = 100 + seq): DochubSearchHit => ({
  seq,
  id,
  title: `Документ ${seq}`,
  doc_type: 'report',
  category_name: null,
  summary_preview: '',
  match_reason: 'похож по смыслу',
  score: 0.5,
  can_open: canOpen,
  snippets: [],
});

function setup(options: {
  hits: DochubSearchHit[];
  degraded?: boolean;
  chapters?: number;
  failOutline?: number;
  hangOn?: string;
}) {
  const calls = { search: [] as number[], outline: [] as number[], summary: [] as number[] };
  const client = {
    search: async (_collection: number, _query: string, topK: number) => {
      calls.search.push(topK);
      return {
        collection_id: 7,
        query: 'q',
        degraded: options.degraded ?? false,
        hits: options.hits,
      } satisfies DochubSearchResponse;
    },
    getOutline: async (id: number): Promise<DochubOutline> => {
      calls.outline.push(id);
      if (id === options.failOutline) {
        throw new DochubError({ kind: 'server', message: 'boom' });
      }
      return {
        document_id: id,
        title: `Документ ${id}`,
        content_version: 'v1',
        chapters: Array.from({ length: options.chapters ?? 2 }, (_, index) => ({
          index,
          heading: `Часть ${index}`,
          chars: 100,
          page_from: index + 1,
          page_to: index + 1,
        })),
      };
    },
    getContent: async (id: number, selection: { chapter: number }): Promise<DochubContent> => ({
      document_id: id,
      content_version: 'v1',
      chapter: selection.chapter,
      page_from: selection.chapter + 1,
      page_to: selection.chapter + 1,
      chars: 20,
      truncated: false,
      text: `${selection.chapter === 0 ? 'турбодетандер' : 'медленно'} в документе ${id}`,
    }),
    getSummary: async (_collection: number, id: number) => {
      calls.summary.push(id);
      return {
        id,
        title: 'т',
        summary: 'турбодетандер по выжимке',
        truncated: false,
        can_open: false,
      };
    },
  } as unknown as DochubClient;

  const prompts: string[] = [];
  const llm: DochubLlm = {
    model: 'stub',
    invoke: async (prompt, budget, phase) => {
      budget.chargeLlm(phase);
      prompts.push(prompt);
      if (options.hangOn != null && prompt.includes(options.hangOn)) {
        await new Promise((resolve) => budget.workSignal.addEventListener('abort', resolve));
        throw stoppedError(budget, 'stub');
      }
      if (prompt.includes('--- РАЗБОРЫ ---')) {
        return 'ОБЩАЯ СВОДКА';
      }
      if (prompt.includes('--- ВЫПИСКИ ---')) {
        return 'разбор документа';
      }
      if (prompt.includes('Верни ТОЛЬКО номера частей')) {
        return '1';
      }
      return prompt.includes('турбодетандер') ? 'турбодетандер (с. 1)' : NO_DATA;
    },
  };
  return { client, llm, calls, prompts };
}

const survey = (
  env: ReturnType<typeof setup>,
  overrides: { maxDocuments?: number; depth?: 'summaries' | 'full'; limits?: DochubLimits } = {},
) => {
  const budgetLimits = overrides.limits ?? limits();
  const budget = createRunBudget({ limits: budgetLimits });
  return surveyCollection({
    collectionId: 7,
    collectionName: 'Нефтяное хозяйство 2018',
    question: 'турбодетандер?',
    maxDocuments: overrides.maxDocuments ?? 6,
    depth: overrides.depth ?? 'summaries',
    client: env.client,
    catalog: createDochubCatalog({ client: env.client }),
    llm: env.llm,
    budget,
    limits: budgetLimits,
    search: { defaultTopK: 8, maxTopK: 20, slotRetries: 2, slotRetryDelayMs: 1 },
  }).finally(() => budget.dispose());
};

describe('surveyCollection', () => {
  /** Search holds DocHub's ask slot; a survey must never fire it more than once. */
  it('searches once, reads the top documents and reduces across them', async () => {
    const env = setup({ hits: [hit(1), hit(2), hit(3), hit(4)] });

    const result = await survey(env, { maxDocuments: 3 });

    expect(env.calls.search).toEqual([6]);
    expect(env.calls.outline.sort()).toEqual([101, 102, 103]);
    expect(result.documents.map((document) => document.ref.seq).sort()).toEqual([1, 2, 3]);
    expect(result.synthesis).toBe('ОБЩАЯ СВОДКА');
    expect(result.notes.join(' ')).toContain('разобраны 3');
    expect(env.prompts.filter((prompt) => prompt.includes('--- РАЗБОРЫ ---'))).toHaveLength(1);
  });

  it('keeps a closed document to its summary and says so', async () => {
    const env = setup({ hits: [hit(1, false)] });

    const result = await survey(env);

    expect(env.calls.outline).toEqual([]);
    expect(env.calls.summary).toEqual([101]);
    expect(result.documents[0].source).toBe('summary');
    const reduce = env.prompts.find((prompt) => prompt.includes('--- РАЗБОРЫ ---')) ?? '';
    expect(reduce).toContain('№1 «Документ 1» (только выжимка)');
  });

  it('reads only a few parts per document at the summaries depth', async () => {
    const env = setup({ hits: [hit(1)], chapters: 10 });

    await survey(env);

    const extractions = env.prompts.filter((prompt) => prompt.includes('--- ТЕКСТ ---'));
    expect(extractions).toHaveLength(3);
  });

  it('reads deeper at the full depth', async () => {
    const env = setup({ hits: [hit(1)], chapters: 10 });

    await survey(env, { depth: 'full' });

    const extractions = env.prompts.filter((prompt) => prompt.includes('--- ТЕКСТ ---'));
    expect(extractions).toHaveLength(10);
  });

  it('lists the documents it could not read instead of dropping them', async () => {
    const env = setup({ hits: [hit(1), hit(2)], failOutline: 102 });

    const result = await survey(env);

    expect(result.documents.map((document) => document.ref.seq)).toEqual([1]);
    expect(result.skipped.map((ref) => ref.seq)).toEqual([2]);
    expect(formatSurveyResult(result, [], 6000)).toContain(
      'Не разобраны (бюджет вызова или ошибка): №2 «Документ 2»',
    );
  });

  it('skips documents once the budget is spent and still reduces', async () => {
    const env = setup({ hits: [hit(1), hit(2), hit(3)], chapters: 1 });

    const result = await survey(env, {
      limits: limits({ maxLlmCalls: 3, documentConcurrency: 1 }),
    });

    expect(result.documents.length).toBeLessThan(3);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('answers plainly when nothing was found', async () => {
    const env = setup({ hits: [], degraded: true });

    const result = await survey(env);

    expect(result.synthesis).toContain('не нашлось документов');
    expect(result.notes[0]).toContain('без разбора запроса');
    expect(env.prompts).toHaveLength(0);
  });

  it('makes the found documents readable by dochub_read afterwards', async () => {
    const env = setup({ hits: [hit(5)] });
    const catalog = createDochubCatalog({ client: env.client });
    const budget = createRunBudget({ limits: limits() });

    await surveyCollection({
      collectionId: 7,
      collectionName: 'К',
      question: 'турбодетандер?',
      maxDocuments: 1,
      depth: 'summaries',
      client: env.client,
      catalog,
      llm: env.llm,
      budget,
      limits: limits(),
      search: { defaultTopK: 8, maxTopK: 20, slotRetries: 2, slotRetryDelayMs: 1 },
    });
    budget.dispose();

    expect(catalog.isInCollection(7, 105)).toBe(true);
  });
});

describe('surveyCollection — sharing the time', () => {
  /** A real run read two issues out of eight and ran out of time for the rest. */
  it('gives every document a share even when extractions hang', async () => {
    const env = setup({
      hits: [hit(1), hit(2), hit(3), hit(4)],
      chapters: 2,
      hangOn: 'медленно',
    });

    const result = await survey(env, {
      maxDocuments: 4,
      depth: 'full',
      limits: limits({
        wallClockMs: 2400,
        reduceReserveMs: 300,
        documentConcurrency: 2,
        chapterConcurrency: 2,
      }),
    });

    expect(result.documents.map((document) => document.ref.seq).sort()).toEqual([1, 2, 3, 4]);
    expect(result.skipped).toEqual([]);
    expect(result.synthesis).toBe('ОБЩАЯ СВОДКА');
  });

  it('splits the work time over the waves not yet started', () => {
    const slice = (index: number) =>
      documentSliceMs({ workRemainingMs: 900, index, total: 8, concurrency: 3 });
    expect([0, 2, 3, 5, 6, 7].map(slice)).toEqual([300, 300, 450, 450, 900, 900]);
  });

  it('caps the parts per document by its share of the model calls', () => {
    const base = limits({ maxLlmCalls: 80, maxChapters: 40 });
    expect(documentChapterCap('full', base, 8)).toBe(9);
    expect(documentChapterCap('full', base, 2)).toBe(20);
    expect(documentChapterCap('summaries', base, 2)).toBe(3);
    expect(documentChapterCap('full', limits({ maxLlmCalls: 3 }), 12)).toBe(1);
  });
});

describe('formatSurveyResult', () => {
  it('puts the summary first and stays within the limit', async () => {
    const env = setup({ hits: [hit(1), hit(2)] });
    const result = await survey(env);
    const text = formatSurveyResult(result, ['⚠ заметка'], 6000);

    expect(text.indexOf('Сводка:')).toBeLessThan(text.indexOf('По документам:'));
    expect(text).toContain('№1 «Документ 1» — разбор документа');
    expect(text).toContain('⚠ заметка');
    expect(formatSurveyResult(result, [], 80).length).toBeLessThanOrEqual(80);
  });
});
