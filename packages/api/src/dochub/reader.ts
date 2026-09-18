import { logger } from '@librechat/data-schemas';
import type {
  DochubChapter,
  DochubChapterFinding,
  DochubDocumentRef,
  DochubLimits,
  DochubOutline,
  DochubReadResult,
} from './types';
import type { DochubClient } from './client';
import type { RunBudget } from './budget';
import type { DochubLlm } from './llm';
import {
  documentReducePrompt,
  extractionPrompt,
  fullDocumentPrompt,
  isNoData,
  parseSelection,
  selectionPrompt,
  summaryPrompt,
} from './prompts';
import { countTokens } from '~/utils/tokenizer';
import { mapWithConcurrency } from './budget';
import { DochubError } from './errors';

export type DochubReadScope = 'auto' | 'full' | 'summary';

export interface ReadDocumentParams {
  ref: DochubDocumentRef;
  question: string;
  scope: DochubReadScope;
  pages?: { from: number; to?: number };
  client: DochubClient;
  llm: DochubLlm;
  budget: RunBudget;
  limits: DochubLimits;
  /** Survey lowers it so one document cannot eat the whole budget. */
  maxChapters?: number;
  /** Survey keeps each document's answer short: only a part of it reaches the chat. */
  answerCharLimit?: number;
}

const PAGE_MARKER = /<!--\s*page:\s*\d+\s*-->/g;
/** The share of the model's window a chapter may occupy; the rest is prompt and answer. */
const CONTEXT_SHARE = 0.6;
const MAX_SPLIT_DEPTH = 3;

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

const isKind = (error: unknown, kind: DochubError['kind']): boolean =>
  error instanceof DochubError && error.kind === kind;

function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^a-zа-я0-9]+/i)
      .filter((word) => word.length >= 4)
      .map((word) => word.slice(0, 5)),
  );
}

/**
 * Chapters to read when the document has more than the cap. The model picks
 * them from the outline; word overlap with the headings is the fallback when
 * the model answers with nothing usable, and it also fills the remaining slots.
 * The first chapter is always kept: it usually carries the abstract.
 */
export function keywordRanking(question: string, chapters: readonly DochubChapter[]): number[] {
  const wanted = stems(question);
  return [...chapters]
    .map((chapter) => ({
      index: chapter.index,
      score: [...stems(chapter.heading ?? '')].filter((stem) => wanted.has(stem)).length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.index);
}

async function planChapters(
  params: ReadDocumentParams,
  outline: DochubOutline,
  cap: number,
): Promise<number[]> {
  const { chapters } = outline;
  if (chapters.length <= cap) {
    return chapters.map((chapter) => chapter.index);
  }

  let chosen: number[] = [];
  try {
    const answer = await params.llm.invoke(
      selectionPrompt({
        title: params.ref.title,
        question: params.question,
        chapters,
        count: cap,
      }),
      params.budget,
    );
    chosen = parseSelection(answer, chapters.length, cap);
  } catch (error) {
    if (isKind(error, 'aborted')) {
      throw error;
    }
    /** Out of time or calls for the selection: headings still give a usable plan. */
    if (!isKind(error, 'budget')) {
      logger.warn(`[dochub] chapter selection failed for document ${params.ref.id}`, error);
    }
  }

  const plan = new Set<number>([0, ...chosen]);
  for (const index of keywordRanking(params.question, chapters)) {
    if (plan.size >= cap) {
      break;
    }
    plan.add(index);
  }
  return [...plan].slice(0, cap).sort((left, right) => left - right);
}

/** Splits on page markers into two halves; a text without markers is cut in the middle. */
function halve(text: string): [string, string] {
  const markers = [...text.matchAll(PAGE_MARKER)].map((match) => match.index ?? 0);
  const middle = text.length / 2;
  const cut = markers
    .filter((position) => position > 0)
    .reduce(
      (best, position) => (Math.abs(position - middle) < Math.abs(best - middle) ? position : best),
      Math.floor(middle),
    );
  return [text.slice(0, cut), text.slice(cut)];
}

async function fitToContext(text: string, llm: DochubLlm, depth = 0): Promise<string[]> {
  if (llm.contextTokens == null || depth >= MAX_SPLIT_DEPTH) {
    return [text];
  }
  const tokens = await countTokens(text);
  if (tokens <= llm.contextTokens * CONTEXT_SHARE) {
    return [text];
  }
  const [head, tail] = halve(text);
  return [
    ...(await fitToContext(head, llm, depth + 1)),
    ...(await fitToContext(tail, llm, depth + 1)),
  ];
}

async function extract(
  params: ReadDocumentParams,
  chapter: DochubChapter,
  text: string,
): Promise<string> {
  const pieces = await fitToContext(text, params.llm);
  const answers: string[] = [];
  for (const piece of pieces) {
    const answer = await params.llm.invoke(
      extractionPrompt({
        title: params.ref.title,
        heading: chapter.heading,
        pageFrom: chapter.page_from,
        pageTo: chapter.page_to,
        question: params.question,
        limit: params.limits.extractionCharLimit,
        text: piece,
      }),
      params.budget,
    );
    if (!isNoData(answer)) {
      answers.push(answer.trim());
    }
  }
  return clip(answers.join('\n'), Math.round(params.limits.extractionCharLimit * 1.2));
}

async function readChapters(
  params: ReadDocumentParams,
  outline: DochubOutline,
  plan: readonly number[],
): Promise<{ findings: DochubChapterFinding[]; mismatch: boolean; read: number }> {
  const byIndex = new Map(outline.chapters.map((chapter) => [chapter.index, chapter]));
  let mismatch = false;
  let read = 0;

  const settled = await mapWithConcurrency(
    plan,
    params.limits.chapterConcurrency,
    async (index): Promise<DochubChapterFinding | null> => {
      const { budget } = params;
      const spent = budget.exhausted();
      if (mismatch || budget.inReduceWindow() || spent.http || spent.llm || budget.signal.aborted) {
        return null;
      }
      const chapter = byIndex.get(index) as DochubChapter;
      try {
        const content = await params.client.getContent(
          params.ref.id,
          { chapter: index },
          outline.content_version,
        );
        const text = await extract(params, chapter, content.text);
        read += 1;
        return {
          chapterIndex: index,
          heading: chapter.heading,
          pageFrom: content.page_from ?? chapter.page_from,
          pageTo: content.page_to ?? chapter.page_to,
          text,
          truncated: content.truncated,
        };
      } catch (error) {
        if (isKind(error, 'version_mismatch')) {
          mismatch = true;
          return null;
        }
        /** A budget stop is not a failed chapter: the coverage note reports it. */
        if (isKind(error, 'aborted') || isKind(error, 'budget') || isKind(error, 'not_found')) {
          throw error;
        }
        logger.warn(`[dochub] chapter ${index} of document ${params.ref.id} failed`, error);
        budget.note(`⚠ Часть ${index} документа №${params.ref.seq} прочитать не удалось.`);
        return null;
      }
    },
  );

  const findings: DochubChapterFinding[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') {
      if (isKind(result.reason, 'not_found')) {
        throw result.reason;
      }
      continue;
    }
    if (result.value != null) {
      findings.push(result.value);
    }
  }
  return { findings, mismatch, read };
}

const TRUNCATED_NOTE =
  '⚠ Часть документа длиннее предела одного ответа DocHub и прочитана не полностью.';

/**
 * A small document fits one model call whole: fetch every chapter, and if the
 * combined text stays inside the model's context share, answer directly from
 * it instead of extracting per chapter and reducing the extracts afterward.
 * Returns null to let the chaptered path run instead — on a document that
 * turns out too big, on a version change mid-fetch, or on a budget/transient
 * failure the chaptered path is better placed to report.
 */
async function tryFastRead(
  params: ReadDocumentParams,
  outline: DochubOutline,
  notes: readonly string[],
): Promise<DochubReadResult | null> {
  const { budget, llm } = params;
  if (llm.contextTokens == null) {
    return null;
  }

  const settled = await mapWithConcurrency(
    outline.chapters,
    params.limits.chapterConcurrency,
    (chapter) =>
      params.client.getContent(params.ref.id, { chapter: chapter.index }, outline.content_version),
  );

  const parts: string[] = [];
  const findings: DochubChapterFinding[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      if (isKind(result.reason, 'aborted')) {
        throw result.reason;
      }
      return null;
    }
    const chapter = outline.chapters[index];
    const heading = chapter.heading ? ` «${chapter.heading}»` : '';
    parts.push(`### Часть ${chapter.index}${heading}\n${result.value.text}`);
    findings.push({
      chapterIndex: chapter.index,
      heading: chapter.heading,
      pageFrom: result.value.page_from ?? chapter.page_from,
      pageTo: result.value.page_to ?? chapter.page_to,
      text: '',
      truncated: result.value.truncated,
    });
  }

  const combined = parts.join('\n\n');
  const pieces = await fitToContext(combined, llm);
  if (pieces.length > 1) {
    return null;
  }

  let answer: string;
  try {
    answer = await llm.invoke(
      fullDocumentPrompt({
        seq: params.ref.seq,
        title: params.ref.title,
        question: params.question,
        limit: params.answerCharLimit ?? params.limits.resultCharLimit,
        text: combined,
      }),
      budget,
      'reduce',
    );
  } catch (error) {
    if (isKind(error, 'aborted')) {
      throw error;
    }
    logger.warn(`[dochub] fast read failed for document ${params.ref.id}`, error);
    return null;
  }

  const synthesis = isNoData(answer)
    ? `В документе №${params.ref.seq} не нашлось сведений по вопросу.`
    : answer.trim();

  return {
    ref: params.ref,
    source: 'content',
    findings,
    synthesis,
    chaptersTotal: outline.chapters.length,
    chaptersRead: outline.chapters.length,
    notes: [
      ...notes,
      ...(findings.some((finding) => finding.truncated) ? [TRUNCATED_NOTE] : []),
      ...budget.notes(),
    ],
  };
}

function emptyResult(
  ref: DochubDocumentRef,
  source: DochubReadResult['source'],
  synthesis: string,
  notes: string[],
): DochubReadResult {
  return { ref, source, findings: [], synthesis, chaptersTotal: 0, chaptersRead: 0, notes };
}

async function readSummary(params: ReadDocumentParams, notes: string[]): Promise<DochubReadResult> {
  const { ref } = params;
  const summary = await params.client.getSummary(ref.collectionId, ref.id);
  const answer = await params.llm.invoke(
    summaryPrompt({
      title: ref.title,
      question: params.question,
      limit: params.limits.extractionCharLimit * 2,
      summary: summary.summary,
    }),
    params.budget,
    'reduce',
  );
  const synthesis = isNoData(answer)
    ? `В выжимке документа №${ref.seq} нет сведений по вопросу.`
    : answer.trim();
  return emptyResult(ref, 'summary', synthesis, [...notes, ...params.budget.notes()]);
}

/** A closed document without a summary has nothing left to read. */
async function readSummaryOrExplain(
  params: ReadDocumentParams,
  notes: string[],
): Promise<DochubReadResult> {
  try {
    return await readSummary(params, notes);
  } catch (error) {
    if (!isKind(error, 'not_found')) {
      throw error;
    }
    return emptyResult(
      params.ref,
      'summary',
      `У документа №${params.ref.seq} нет ни доступного текста, ни выжимки.`,
      notes,
    );
  }
}

async function reduce(
  params: ReadDocumentParams,
  findings: readonly DochubChapterFinding[],
): Promise<string> {
  const useful = findings.filter((finding) => finding.text.length > 0);
  if (useful.length === 0) {
    return `В документе №${params.ref.seq} не нашлось сведений по вопросу.`;
  }
  try {
    return await params.llm.invoke(
      documentReducePrompt({
        seq: params.ref.seq,
        title: params.ref.title,
        question: params.question,
        limit: params.answerCharLimit ?? params.limits.resultCharLimit,
        findings: useful,
      }),
      params.budget,
      'reduce',
    );
  } catch (error) {
    if (isKind(error, 'aborted')) {
      throw error;
    }
    /** Without the reduce step the raw extracts are still worth returning. */
    logger.warn(`[dochub] reduce failed for document ${params.ref.id}`, error);
    params.budget.note('⚠ Итоговое сведение не выполнено — ниже выписки по частям документа.');
    return useful.map((finding) => `Часть ${finding.chapterIndex}: ${finding.text}`).join('\n\n');
  }
}

/**
 * Reads one document as deep as the question and the budget allow and returns
 * a condensed answer. It never throws for a budget hit: whatever was read is
 * reduced and the result says what was left out.
 */
export async function readDocument(params: ReadDocumentParams): Promise<DochubReadResult> {
  const { ref, client, budget } = params;
  const notes: string[] = [];

  if (!ref.canOpen) {
    notes.push(
      `Полный текст документа №${ref.seq} пользователю недоступен — ответ построен по выжимке.`,
    );
    return readSummaryOrExplain(params, notes);
  }
  if (params.scope === 'summary') {
    try {
      return await readSummary(params, notes);
    } catch (error) {
      /** Search can surface a readable document that has no summary yet. */
      if (!isKind(error, 'not_found')) {
        throw error;
      }
      notes.push('У документа нет выжимки — прочитан текст.');
    }
  }

  if (params.pages != null) {
    try {
      const content = await client.getContent(ref.id, {
        pageFrom: params.pages.from,
        pageTo: params.pages.to,
      });
      const chapter: DochubChapter = {
        index: 0,
        heading: null,
        chars: content.chars,
        page_from: content.page_from,
        page_to: content.page_to,
      };
      const text = await extract(params, chapter, content.text);
      const findings: DochubChapterFinding[] = [
        {
          chapterIndex: 0,
          heading: null,
          pageFrom: content.page_from,
          pageTo: content.page_to,
          text,
          truncated: content.truncated,
        },
      ];
      if (content.truncated) {
        notes.push('⚠ Диапазон страниц слишком велик и прочитан не полностью — сузь его.');
      }
      return {
        ref,
        source: 'content',
        findings,
        synthesis: await reduce(params, findings),
        chaptersTotal: 1,
        chaptersRead: 1,
        notes: [...notes, ...budget.notes()],
      };
    } catch (error) {
      if (!isKind(error, 'bad_request')) {
        throw error;
      }
      notes.push(
        'Страницы в документе не размечены или вне диапазона — документ прочитан по частям.',
      );
    }
  }

  let outline = await client.getOutline(ref.id);
  if (outline.chapters.length === 0) {
    notes.push(
      'Текст документа не распознан (возможно, ещё обрабатывается) — использована выжимка.',
    );
    return readSummaryOrExplain(params, notes);
  }

  const cap = params.maxChapters ?? params.limits.maxChapters;
  if (outline.chapters.length <= cap) {
    const fast = await tryFastRead(params, outline, notes);
    if (fast) {
      return fast;
    }
  }

  let plan = await planChapters(params, outline, cap);
  let pass = await readChapters(params, outline, plan);

  if (pass.mismatch) {
    outline = await client.getOutline(ref.id);
    plan = await planChapters(params, outline, cap);
    pass = await readChapters(params, outline, plan);
    if (pass.mismatch) {
      notes.push('⚠ Документ изменился во время чтения — результат может быть неполным.');
    }
  }

  const total = outline.chapters.length;
  if (plan.length < total) {
    const skipped = outline.chapters
      .filter((chapter) => !plan.includes(chapter.index))
      .map((chapter) => chapter.index);
    notes.push(
      `Документ содержит ${total} частей, разобраны ${plan.length} наиболее относящихся к вопросу; не читались части: ${skipped.join(', ')}.`,
    );
  }
  if (pass.read < plan.length) {
    notes.push(
      `⚠ Прочитано ${pass.read} из ${plan.length} запланированных частей: исчерпан бюджет вызова. Результат неполный — сузь вопрос или укажи страницы.`,
    );
  }
  if (pass.findings.some((finding) => finding.truncated)) {
    notes.push(TRUNCATED_NOTE);
  }

  return {
    ref,
    source: 'content',
    findings: pass.findings.sort((left, right) => left.chapterIndex - right.chapterIndex),
    synthesis: await reduce(params, pass.findings),
    chaptersTotal: total,
    chaptersRead: pass.read,
    notes: [...notes, ...budget.notes()],
  };
}

function pageSpan(findings: readonly DochubChapterFinding[]): string {
  const from = findings
    .map((finding) => finding.pageFrom)
    .filter((page): page is number => page != null);
  const to = findings
    .map((finding) => finding.pageTo)
    .filter((page): page is number => page != null);
  if (from.length === 0) {
    return '';
  }
  return `, с. ${Math.min(...from)}–${Math.max(...to)}`;
}

/** What the chat model receives: header, answer, notices — within the size limit. */
export function formatReadResult(
  result: DochubReadResult,
  question: string,
  limit: number,
): string {
  const { ref } = result;
  const coverage =
    result.source === 'summary'
      ? 'Источник: выжимка документа.'
      : `Прочитано частей: ${result.chaptersRead} из ${result.chaptersTotal}${pageSpan(result.findings)}.`;
  const notes = result.notes.length > 0 ? `\n\n${result.notes.join('\n')}` : '';
  const text = `№${ref.seq} «${ref.title}» (коллекция «${ref.collectionName}»)
${coverage}

Ответ по вопросу «${question}»:
${result.synthesis.trim()}${notes}`;
  return text.length <= limit ? text : `${text.slice(0, limit - 20)}\n…(ответ обрезан)`;
}
