import type {
  DochubChapter,
  DochubContent,
  DochubDocumentRef,
  DochubLimits,
  DochubOutline,
  DochubSummaryResponse,
} from './types';
import type { DochubClient } from './client';
import type { DochubLlm } from './llm';
import { formatReadResult, keywordRanking, readDocument } from './reader';
import { createRunBudget, stoppedError } from './budget';
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

const ref = (overrides: Partial<DochubDocumentRef> = {}): DochubDocumentRef => ({
  collectionId: 7,
  collectionName: 'Нефтяное хозяйство 2018',
  seq: 3,
  id: 103,
  title: 'Испытания турбодетандера',
  canOpen: true,
  ...overrides,
});

const chapter = (index: number, heading: string | null = null): DochubChapter => ({
  index,
  heading,
  chars: 1000,
  page_from: index * 10 + 1,
  page_to: index * 10 + 10,
});

interface StubDoc {
  outline?: DochubOutline | DochubOutline[];
  content?: (chapter: number, version?: string) => DochubContent | DochubError;
  pages?: (from: number, to?: number) => DochubContent | DochubError;
  summary?: DochubSummaryResponse | DochubError;
}

function stubClient(doc: StubDoc) {
  const calls = { outline: 0, content: [] as number[], summary: 0, pages: 0 };
  const outlines = Array.isArray(doc.outline) ? [...doc.outline] : doc.outline;
  const client = {
    getOutline: async () => {
      calls.outline += 1;
      const next = Array.isArray(outlines) ? (outlines.shift() ?? doc.outline) : outlines;
      return next as DochubOutline;
    },
    getContent: async (
      _id: number,
      selection: { chapter: number } | { pageFrom: number; pageTo?: number },
      version?: string,
    ) => {
      if ('chapter' in selection) {
        calls.content.push(selection.chapter);
        const result = doc.content?.(selection.chapter, version);
        if (result instanceof DochubError) {
          throw result;
        }
        return result as DochubContent;
      }
      calls.pages += 1;
      const result = doc.pages?.(selection.pageFrom, selection.pageTo);
      if (result instanceof DochubError) {
        throw result;
      }
      return result as DochubContent;
    },
    getSummary: async () => {
      calls.summary += 1;
      if (doc.summary instanceof DochubError) {
        throw doc.summary;
      }
      return doc.summary as DochubSummaryResponse;
    },
  } as unknown as DochubClient;
  return { client, calls };
}

const content = (index: number, text: string, version = 'v1'): DochubContent => ({
  document_id: 103,
  content_version: version,
  chapter: index,
  page_from: index * 10 + 1,
  page_to: index * 10 + 10,
  chars: text.length,
  truncated: false,
  text,
});

/**
 * A deterministic stand-in for the model: extraction echoes the relevant line
 * of the fragment, selection and reduce answer from what the prompt carries.
 */
function stubLlm(
  options: {
    selection?: string;
    failReduce?: boolean;
    hangOn?: string;
    contextTokens?: number;
    failFast?: boolean;
  } = {},
) {
  const prompts: string[] = [];
  const llm: DochubLlm = {
    model: 'stub',
    contextTokens: options.contextTokens,
    invoke: async (prompt, budget, phase) => {
      budget.chargeLlm(phase);
      prompts.push(prompt);
      if (options.hangOn != null && prompt.includes(options.hangOn)) {
        await new Promise((resolve) => budget.workSignal.addEventListener('abort', resolve));
        throw stoppedError(budget, 'stub');
      }
      if (prompt.includes('Верни ТОЛЬКО номера частей')) {
        return options.selection ?? '';
      }
      if (
        prompt.includes('--- ТЕКСТ ---') &&
        prompt.includes('Составь ответ на вопрос строго по тексту')
      ) {
        if (options.failFast) {
          throw new Error('gateway down');
        }
        const text = prompt.split('--- ТЕКСТ ---')[1] ?? '';
        return text.includes('турбодетандер')
          ? `СВОДКА-ОДНИМ-ВЫЗОВОМ: ${text.split('\n').length} строк`
          : NO_DATA;
      }
      if (prompt.includes('--- ВЫПИСКИ ---')) {
        if (options.failReduce) {
          throw new Error('gateway down');
        }
        return `СВОДКА: ${prompt.split('--- ВЫПИСКИ ---')[1].trim().split('\n').length} строк`;
      }
      if (prompt.includes('--- ВЫЖИМКА ---')) {
        return 'Из выжимки: турбодетандер испытан.';
      }
      const text = prompt.split('--- ТЕКСТ ---')[1] ?? '';
      const relevant = text.split('\n').filter((line) => line.includes('турбодетандер'));
      return relevant.length > 0 ? relevant.join('\n') : NO_DATA;
    },
  };
  return { llm, prompts };
}

const run = (
  doc: StubDoc,
  params: {
    ref?: DochubDocumentRef;
    scope?: 'auto' | 'full' | 'summary';
    pages?: { from: number; to?: number };
    limits?: DochubLimits;
    llm?: ReturnType<typeof stubLlm>;
    maxChapters?: number;
  } = {},
) => {
  const stub = stubClient(doc);
  const model = params.llm ?? stubLlm();
  const budgetLimits = params.limits ?? limits();
  const budget = createRunBudget({ limits: budgetLimits });
  const promise = readDocument({
    ref: params.ref ?? ref(),
    question: 'Как испытывали турбодетандер?',
    scope: params.scope ?? 'auto',
    pages: params.pages,
    client: stub.client,
    llm: model.llm,
    budget,
    limits: budgetLimits,
    maxChapters: params.maxChapters,
  }).finally(() => budget.dispose());
  return { promise, calls: stub.calls, prompts: model.prompts, budget };
};

const outline = (chapters: DochubChapter[], version = 'v1'): DochubOutline => ({
  document_id: 103,
  title: 'Испытания турбодетандера',
  content_version: version,
  chapters,
});

describe('readDocument — whole document', () => {
  it('reads every chapter, keeps page citations and reduces once', async () => {
    const chapters = Array.from({ length: 9 }, (_, index) => chapter(index));
    const { promise, calls, prompts } = run({
      outline: outline(chapters),
      content: (index) =>
        content(
          index,
          `<!-- page: ${index * 10 + 1} -->\n${index % 3 === 0 ? `турбодетандер в части ${index}` : 'прочее'}`,
        ),
    });

    const result = await promise;

    expect(calls.content.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.chaptersRead).toBe(9);
    expect(result.chaptersTotal).toBe(9);
    /** Only chapters that held something reach the reduce step. */
    expect(result.findings.filter((finding) => finding.text).map((f) => f.chapterIndex)).toEqual([
      0, 3, 6,
    ]);
    expect(prompts.filter((prompt) => prompt.includes('--- ВЫПИСКИ ---'))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes('--- ТЕКСТ ---'))).toHaveLength(9);
    expect(result.synthesis).toMatch(/^СВОДКА/);
    expect(result.notes).toEqual([]);
  });

  it('pins every chapter read to the outline version', async () => {
    const versions: Array<string | undefined> = [];
    const { promise } = run({
      outline: outline([chapter(0), chapter(1)], 'v7'),
      content: (index, version) => {
        versions.push(version);
        return content(index, 'турбодетандер', 'v7');
      },
    });

    await promise;
    expect(versions).toEqual(['v7', 'v7']);
  });

  it('says so when nothing in the document answers the question', async () => {
    const { promise, prompts } = run({
      outline: outline([chapter(0), chapter(1)]),
      content: (index) => content(index, 'ничего относящегося'),
    });

    const result = await promise;
    expect(result.synthesis).toContain('не нашлось сведений');
    expect(prompts.some((prompt) => prompt.includes('--- ВЫПИСКИ ---'))).toBe(false);
  });

  it('returns the raw extracts when the reduce step fails', async () => {
    const { promise } = run(
      {
        outline: outline([chapter(0)]),
        content: (index) => content(index, 'турбодетандер на стенде'),
      },
      { llm: stubLlm({ failReduce: true }) },
    );

    const result = await promise;
    expect(result.synthesis).toContain('Часть 0: турбодетандер на стенде');
    expect(result.notes.join(' ')).toContain('сведение не выполнено');
  });
});

describe('readDocument — fast read', () => {
  it('answers in one call when the whole document fits the context share', async () => {
    const { promise, calls, prompts } = run(
      {
        outline: outline([chapter(0), chapter(1), chapter(2)]),
        content: (index) => content(index, index === 1 ? 'турбодетандер на стенде' : 'прочее'),
      },
      { llm: stubLlm({ contextTokens: 100000 }) },
    );

    const result = await promise;

    expect(calls.content.sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(result.chaptersRead).toBe(3);
    expect(result.chaptersTotal).toBe(3);
    expect(result.synthesis).toMatch(/^СВОДКА-ОДНИМ-ВЫЗОВОМ/);
    /** One model call total: no per-chapter extraction, no separate reduce. */
    expect(prompts).toHaveLength(1);
  });

  it('falls back to the chaptered read when the combined document does not fit', async () => {
    /**
     * Under 4096 chars each chapter goes through the real tokenizer, which
     * compresses this filler to far fewer tokens than the context share; all
     * three concatenated cross 4096 chars and fall back to a byte estimate
     * the fast path's budget cannot absorb.
     */
    const filler = 'x'.repeat(1500);
    const chapters = Array.from({ length: 3 }, (_, index) => chapter(index));
    const { promise, calls, prompts } = run(
      {
        outline: outline(chapters),
        content: (index) =>
          content(index, index === 1 ? `турбодетандер на стенде. ${filler}` : `прочее. ${filler}`),
      },
      { llm: stubLlm({ contextTokens: 5000 }) },
    );

    const result = await promise;

    expect(result.chaptersRead).toBe(3);
    expect(prompts.filter((prompt) => prompt.includes('--- ТЕКСТ ---'))).toHaveLength(3);
    expect(prompts.some((prompt) => prompt.includes('--- ВЫПИСКИ ---'))).toBe(true);
    /** Every chapter is fetched twice: once for the abandoned fast attempt, once for the real read. */
    expect(calls.content.filter((index) => index === 1)).toHaveLength(2);
  });

  it('falls back to the chaptered read when the fast call itself fails', async () => {
    const { promise, prompts } = run(
      {
        outline: outline([chapter(0)]),
        content: (index) => content(index, 'турбодетандер на стенде'),
      },
      { llm: stubLlm({ contextTokens: 100000, failFast: true }) },
    );

    const result = await promise;

    expect(result.synthesis).toMatch(/^СВОДКА/);
    expect(result.synthesis).not.toMatch(/^СВОДКА-ОДНИМ-ВЫЗОВОМ/);
    expect(prompts.filter((prompt) => prompt.includes('--- ТЕКСТ ---'))).toHaveLength(2);
  });

  it('never attempts a fast read when the model context size is unknown', async () => {
    const { promise, calls } = run({
      outline: outline([chapter(0)]),
      content: (index) => content(index, 'турбодетандер'),
    });

    await promise;
    expect(calls.content).toEqual([0]);
  });
});

describe('readDocument — long documents', () => {
  const thirty = Array.from({ length: 30 }, (_, index) =>
    chapter(index, index === 17 ? 'Испытания турбодетандера на стенде' : `Раздел ${index}`),
  );

  it('lets the model pick the chapters and lists the ones left out', async () => {
    const { promise, calls } = run(
      {
        outline: outline(thirty),
        content: (index) => content(index, 'турбодетандер'),
      },
      { llm: stubLlm({ selection: '17, 4, 99, 4' }), maxChapters: 3 },
    );

    const result = await promise;
    expect(calls.content.sort((a, b) => a - b)).toEqual([0, 4, 17]);
    expect(result.chaptersTotal).toBe(30);
    expect(result.notes[0]).toContain('разобраны 3');
    expect(result.notes[0]).toContain('не читались части: 1, 2, 3, 5');
  });

  /** A model that answers with nonsense must still produce a sensible plan. */
  it('falls back to heading overlap when the selection is unusable', async () => {
    const { promise, calls } = run(
      {
        outline: outline(thirty),
        content: (index) => content(index, 'турбодетандер'),
      },
      { llm: stubLlm({ selection: 'не знаю' }), maxChapters: 2 },
    );

    await promise;
    expect(calls.content.sort((a, b) => a - b)).toEqual([0, 17]);
  });

  it('ranks headings by the words of the question', () => {
    expect(keywordRanking('испытания турбодетандера', thirty)[0]).toBe(17);
  });
});

describe('readDocument — budget', () => {
  it('stops launching chapters when the LLM budget is spent and still reduces', async () => {
    const chapters = Array.from({ length: 10 }, (_, index) => chapter(index));
    const { promise } = run(
      {
        outline: outline(chapters),
        content: (index) => content(index, 'турбодетандер'),
      },
      { limits: limits({ maxLlmCalls: 4, chapterConcurrency: 1 }) },
    );

    const result = await promise;
    expect(result.chaptersRead).toBeLessThan(10);
    expect(result.notes.join(' ')).toContain('Прочитано');
    /** The reduce has its own allowance past the counter. */
    expect(result.synthesis).toMatch(/^СВОДКА/);
  });

  it('keeps the reduce step when the time runs out', async () => {
    const chapters = Array.from({ length: 5 }, (_, index) => chapter(index));
    const { promise, prompts } = run(
      {
        outline: outline(chapters),
        content: (index) => content(index, 'турбодетандер'),
      },
      /** The whole budget is the reduce reserve: no chapter may start. */
      { limits: limits({ wallClockMs: 60000, reduceReserveMs: 60000 }) },
    );

    const result = await promise;
    expect(result.chaptersRead).toBe(0);
    expect(result.notes.join(' ')).toContain('Прочитано 0 из 5');
    expect(prompts).toHaveLength(0);
  });
});

describe('readDocument — work phase', () => {
  /** The logs of a real run: a slow extraction used to take the reduce down with it. */
  it('cuts a slow extraction at the end of the work phase and still reduces', async () => {
    const budget = createRunBudget({
      limits: limits({ wallClockMs: 600, reduceReserveMs: 300, chapterConcurrency: 2 }),
    });
    const { client } = stubClient({
      outline: outline([chapter(0), chapter(1)]),
      content: (index) => content(index, index === 0 ? 'турбодетандер испытан' : 'медленная часть'),
    });
    const { llm, prompts } = stubLlm({ hangOn: 'медленная часть' });

    const result = await readDocument({
      ref: ref(),
      question: 'турбодетандер?',
      scope: 'auto',
      client,
      llm,
      budget,
      limits: budget.limits,
    });
    budget.dispose();

    expect(result.chaptersRead).toBe(1);
    expect(result.synthesis).toMatch(/^СВОДКА/);
    expect(result.findings.map((finding) => finding.chapterIndex)).toEqual([0]);
    expect(result.notes.join(' ')).toContain('Прочитано 1 из 2');
    expect(result.notes.join(' ')).not.toContain('прочитать не удалось');
    expect(prompts.some((prompt) => prompt.includes('--- ВЫПИСКИ ---'))).toBe(true);
  });

  it('falls back to the headings when the selection call is out of budget', async () => {
    const chapters = Array.from({ length: 5 }, (_, index) =>
      chapter(index, index === 3 ? 'Турбодетандер' : `Глава ${index}`),
    );
    const budget = createRunBudget({ limits: limits({ maxLlmCalls: 0 }) });
    const { client, calls } = stubClient({
      outline: outline(chapters),
      content: (index) => content(index, 'турбодетандер'),
    });

    const result = await readDocument({
      ref: ref(),
      question: 'турбодетандер',
      scope: 'auto',
      client,
      llm: stubLlm().llm,
      budget,
      limits: budget.limits,
      maxChapters: 2,
    });
    budget.dispose();

    expect(result.ref.id).toBe(103);
    expect(calls.content).toEqual([]);
    expect(result.notes.join(' ')).toContain('не читались части: 1, 2, 4');
  });
});

describe('readDocument — document changes and access', () => {
  it('re-reads the outline once when the document changed', async () => {
    let first = true;
    const { promise, calls } = run({
      outline: [outline([chapter(0), chapter(1)], 'v1'), outline([chapter(0)], 'v2')],
      content: (index, version) => {
        if (version === 'v1' && first) {
          first = false;
          return new DochubError({ kind: 'version_mismatch', message: 'changed' });
        }
        return content(index, 'турбодетандер', 'v2');
      },
    });

    const result = await promise;
    expect(calls.outline).toBe(2);
    expect(result.chaptersTotal).toBe(1);
    expect(result.notes.join(' ')).not.toContain('изменился');
  });

  it('gives a partial answer when the document keeps changing', async () => {
    const { promise, calls } = run({
      outline: outline([chapter(0)]),
      content: () => new DochubError({ kind: 'version_mismatch', message: 'changed' }),
    });

    const result = await promise;
    expect(calls.outline).toBe(2);
    expect(result.notes.join(' ')).toContain('изменился во время чтения');
  });

  it('never asks for the text of a document the user cannot open', async () => {
    const { promise, calls } = run(
      {
        summary: { id: 103, title: 'Т', summary: 'выжимка', truncated: false, can_open: false },
      },
      { ref: ref({ canOpen: false }) },
    );

    const result = await promise;
    expect(calls.outline).toBe(0);
    expect(calls.content).toEqual([]);
    expect(result.source).toBe('summary');
    expect(result.notes[0]).toContain('Полный текст документа №3 пользователю недоступен');
    expect(result.synthesis).toContain('турбодетандер испытан');
  });

  it('explains a closed document without a summary', async () => {
    const { promise } = run(
      { summary: new DochubError({ kind: 'not_found', message: 'gone' }) },
      { ref: ref({ canOpen: false }) },
    );

    await expect(promise).resolves.toMatchObject({
      synthesis: expect.stringContaining('нет ни доступного текста, ни выжимки'),
    });
  });

  it('reads the text when a readable document has no summary yet', async () => {
    const { promise, calls } = run(
      {
        summary: new DochubError({ kind: 'not_found', message: 'no summary' }),
        outline: outline([chapter(0)]),
        content: (index) => content(index, 'турбодетандер'),
      },
      { scope: 'summary' },
    );

    const result = await promise;
    expect(calls.content).toEqual([0]);
    expect(result.source).toBe('content');
  });

  it('falls back to the summary when the text is not recognised yet', async () => {
    const { promise } = run({
      outline: outline([]),
      summary: { id: 103, title: 'Т', summary: 'выжимка', truncated: false, can_open: true },
    });

    const result = await promise;
    expect(result.source).toBe('summary');
    expect(result.notes[0]).toContain('не распознан');
  });

  it('reads the pages the user named', async () => {
    const { promise, calls } = run(
      {
        pages: (from, to) => ({
          ...content(0, 'турбодетандер на с. 12'),
          chapter: null,
          page_from: from,
          page_to: to ?? from,
        }),
      },
      { pages: { from: 12, to: 14 } },
    );

    const result = await promise;
    expect(calls.pages).toBe(1);
    expect(calls.outline).toBe(0);
    expect(result.findings[0]).toMatchObject({ pageFrom: 12, pageTo: 14 });
  });

  it('reads by chapters when the document has no page markup', async () => {
    const { promise, calls } = run(
      {
        pages: () => new DochubError({ kind: 'bad_request', message: 'no page markers' }),
        outline: outline([chapter(0)]),
        content: (index) => content(index, 'турбодетандер'),
      },
      { pages: { from: 12 } },
    );

    const result = await promise;
    expect(calls.content).toEqual([0]);
    expect(result.notes[0]).toContain('не размечены');
  });
});

describe('formatReadResult', () => {
  it('names the document, the coverage and the notes, within the limit', async () => {
    const { promise } = run({
      outline: outline([chapter(0), chapter(1)]),
      content: (index) => content(index, 'турбодетандер'),
    });
    const result = await promise;
    const text = formatReadResult({ ...result, notes: ['⚠ заметка'] }, 'Как испытывали?', 6000);

    expect(text).toContain('№3 «Испытания турбодетандера» (коллекция «Нефтяное хозяйство 2018»)');
    expect(text).toContain('Прочитано частей: 2 из 2, с. 1–20.');
    expect(text).toContain('⚠ заметка');
    expect(formatReadResult(result, 'вопрос', 60).length).toBeLessThanOrEqual(60);
  });
});
