import { logger } from '@librechat/data-schemas';
import type {
  DochubDocumentRef,
  DochubLimits,
  DochubSearchHit,
  DochubSearchSettings,
  DochubSurveyDocumentResult,
  DochubSurveyResult,
} from './types';
import type { DochubCatalog } from './catalog';
import type { DochubClient } from './client';
import type { RunBudget } from './budget';
import type { DochubLlm } from './llm';
import { surveyReducePrompt } from './prompts';
import { mapWithConcurrency } from './budget';
import { readDocument } from './reader';
import { DochubError } from './errors';

export type DochubSurveyDepth = 'summaries' | 'full';

export interface SurveyCollectionParams {
  collectionId: number;
  collectionName: string;
  question: string;
  maxDocuments: number;
  depth: DochubSurveyDepth;
  client: DochubClient;
  catalog: DochubCatalog;
  llm: DochubLlm;
  budget: RunBudget;
  limits: DochubLimits;
  search: DochubSearchSettings;
}

/** With `summaries` a document still gets its most relevant parts, not just the summary. */
const SUMMARY_DEPTH_CHAPTERS = 3;
/** A document with less time than this is listed as skipped rather than started. */
const MIN_DOCUMENT_MS = 20000;
const minDocumentMs = (limits: DochubLimits): number =>
  Math.min(MIN_DOCUMENT_MS, limits.wallClockMs / 20);

/**
 * Chapters one document may read: the depth's own cap, but never more than its
 * fair share of the call's model budget (one call is kept for chapter selection).
 */
export function documentChapterCap(
  depth: DochubSurveyDepth,
  limits: DochubLimits,
  documents: number,
): number {
  const depthCap =
    depth === 'full' ? Math.max(1, Math.floor(limits.maxChapters / 2)) : SUMMARY_DEPTH_CHAPTERS;
  const share = Math.floor(limits.maxLlmCalls / Math.max(1, documents)) - 1;
  return Math.max(1, Math.min(depthCap, share));
}

/**
 * Time for the document at `index`: what is left for work, split evenly over
 * the waves of documents not yet started. A document that finishes early
 * leaves its remainder to the later waves.
 */
export function documentSliceMs(params: {
  workRemainingMs: number;
  index: number;
  total: number;
  concurrency: number;
}): number {
  const width = Math.max(1, params.concurrency);
  const waves = Math.ceil(params.total / width) - Math.floor(params.index / width);
  return params.workRemainingMs / Math.max(1, waves);
}

const toRef = (collectionName: string, collectionId: number, hit: DochubSearchHit) => ({
  collectionId,
  collectionName,
  seq: hit.seq,
  id: hit.id,
  title: hit.title,
  canOpen: hit.can_open,
});

function uniqueHits(hits: readonly DochubSearchHit[]): DochubSearchHit[] {
  const seen = new Set<number>();
  return hits.filter((hit) => {
    if (seen.has(hit.id)) {
      return false;
    }
    seen.add(hit.id);
    return true;
  });
}

/**
 * Answers a question from a whole collection: one search (it holds DocHub's
 * ask slot, so never in parallel), a sub-agent per selected document, and a
 * cross-document reduce. Documents the budget could not reach are listed, not
 * silently dropped.
 */
export async function surveyCollection(
  params: SurveyCollectionParams,
): Promise<DochubSurveyResult> {
  const { budget, limits, collectionId, collectionName } = params;
  const maxDocuments = Math.max(1, params.maxDocuments);
  const topK = Math.min(maxDocuments * 2, params.search.maxTopK);

  const response = await params.client.search(collectionId, params.question, topK);
  params.catalog.registerHits(collectionId, response.hits);

  const hits = uniqueHits(response.hits);
  const chosen = hits.slice(0, maxDocuments).map((hit) => toRef(collectionName, collectionId, hit));
  const notes: string[] = [];
  if (response.degraded) {
    notes.push('Поиск выполнен без разбора запроса — подбор документов мог быть грубее.');
  }
  if (hits.length > chosen.length) {
    notes.push(`Найдено документов: ${hits.length}, разобраны ${chosen.length} самых релевантных.`);
  }

  const base: Omit<DochubSurveyResult, 'documents' | 'skipped' | 'synthesis'> = {
    collectionId,
    collectionName,
    question: params.question,
    degraded: response.degraded,
    notes,
  };
  if (chosen.length === 0) {
    return {
      ...base,
      documents: [],
      skipped: [],
      synthesis: `В коллекции «${collectionName}» не нашлось документов по вопросу.`,
    };
  }

  const maxChapters = documentChapterCap(params.depth, limits, chosen.length);

  const settled = await mapWithConcurrency(
    chosen,
    limits.documentConcurrency,
    async (ref, index): Promise<DochubSurveyDocumentResult | null> => {
      const spent = budget.exhausted();
      if (budget.inReduceWindow() || spent.http || spent.llm || budget.signal.aborted) {
        return null;
      }
      const durationMs = documentSliceMs({
        workRemainingMs: budget.workRemainingMs(),
        index,
        total: chosen.length,
        concurrency: limits.documentConcurrency,
      });
      if (durationMs < minDocumentMs(limits)) {
        return null;
      }
      const slice = budget.slice({ durationMs, reserveMs: limits.reduceReserveMs });
      try {
        const result = await readDocument({
          ref,
          question: params.question,
          scope: 'auto',
          client: params.client,
          llm: params.llm,
          budget: slice,
          limits,
          maxChapters,
          answerCharLimit: limits.extractionCharLimit * 2,
        });
        return { ref, synthesis: result.synthesis, source: result.source, notes: result.notes };
      } finally {
        slice.dispose();
      }
    },
  );

  const documents: DochubSurveyDocumentResult[] = [];
  const skipped: DochubDocumentRef[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled' && outcome.value != null) {
      documents.push(outcome.value);
      return;
    }
    if (outcome.status === 'rejected') {
      const reason = outcome.reason;
      if (reason instanceof DochubError && reason.kind === 'aborted') {
        throw reason;
      }
      if (!(reason instanceof DochubError && reason.kind === 'budget')) {
        logger.warn(`[dochub] survey could not read document ${chosen[index].id}`, reason);
      }
    }
    skipped.push(chosen[index]);
  });

  return { ...base, documents, skipped, synthesis: await reduceSurvey(params, documents) };
}

async function reduceSurvey(
  params: SurveyCollectionParams,
  documents: readonly DochubSurveyDocumentResult[],
): Promise<string> {
  if (documents.length === 0) {
    return 'Ни один документ не удалось разобрать в пределах бюджета вызова.';
  }
  try {
    return await params.llm.invoke(
      surveyReducePrompt({
        collection: params.collectionName,
        question: params.question,
        limit: params.limits.resultCharLimit,
        documents,
      }),
      params.budget,
      'reduce',
    );
  } catch (error) {
    if (error instanceof DochubError && error.kind === 'aborted') {
      throw error;
    }
    logger.warn('[dochub] survey reduce failed', error);
    params.budget.note('⚠ Общее сведение не выполнено — ниже разборы по документам.');
    return '';
  }
}

/** What the chat model receives: summary first, then one block per document. */
export function formatSurveyResult(
  result: DochubSurveyResult,
  notes: readonly string[],
  limit: number,
): string {
  const lines = [
    `Коллекция «${result.collectionName}», вопрос: «${result.question}». Разобрано документов: ${result.documents.length}.`,
  ];
  if (result.synthesis.trim()) {
    lines.push('', 'Сводка:', result.synthesis.trim());
  }
  lines.push('', 'По документам:');
  for (const document of result.documents) {
    const closed =
      document.source === 'summary' ? ' (только выжимка, полный текст недоступен)' : '';
    const text = document.synthesis.trim().replace(/\s+/g, ' ');
    lines.push(`№${document.ref.seq} «${document.ref.title}»${closed} — ${text.slice(0, 600)}`);
  }
  if (result.skipped.length > 0) {
    const list = result.skipped.map((ref) => `№${ref.seq} «${ref.title}»`).join(', ');
    lines.push(
      '',
      `Не разобраны (бюджет вызова или ошибка): ${list}. Их можно прочитать через dochub_read.`,
    );
  }
  const allNotes = [...new Set([...result.notes, ...notes])];
  if (allNotes.length > 0) {
    lines.push('', ...allNotes);
  }
  const text = lines.join('\n');
  return text.length <= limit ? text : `${text.slice(0, limit - 20)}\n…(ответ обрезан)`;
}
