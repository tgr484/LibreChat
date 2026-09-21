import { logger } from '@librechat/data-schemas';
import type { DochubDocumentRef, DochubLimits } from './types';
import type { DochubClient } from './client';
import type { RunBudget } from './budget';
import type { DochubLlm } from './llm';
import { documentChapterCap, readInSlice } from './survey';
import { mapWithConcurrency } from './budget';
import { DochubError } from './errors';

export type DochubExtractDepth = 'summary' | 'full';

export interface DochubExtractRow {
  ref: DochubDocumentRef;
  text: string;
  source: 'content' | 'summary';
}

export interface DochubExtractResult {
  collectionName: string;
  fields: string[];
  rows: DochubExtractRow[];
  skipped: DochubDocumentRef[];
}

export interface ExtractDocumentsParams {
  collectionName: string;
  refs: DochubDocumentRef[];
  fields: string[];
  depth: DochubExtractDepth;
  client: DochubClient;
  llm: DochubLlm;
  budget: RunBudget;
  limits: DochubLimits;
}

const MIN_ROW_CHARS = 300;

export function extractQuestion(fields: readonly string[]): string {
  const list = fields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  return `Извлеки из документа характеристики. Для каждой дай одну строку «Название: значение» — кратко, факты только из текста, с типами данных, если они запрошены. Если сведений нет, пиши «нет данных».\n${list}`;
}

/**
 * The same fields for every document, in parallel and inside the run budget.
 * Unlike a survey there is no cross-document reduce: the rows are the result,
 * so the chat model never re-reads the prose it would have to merge.
 */
export async function extractFromDocuments(
  params: ExtractDocumentsParams,
): Promise<DochubExtractResult> {
  const { refs, limits, fields, depth } = params;
  const question = extractQuestion(fields);
  const maxChapters = documentChapterCap(
    depth === 'full' ? 'full' : 'summaries',
    limits,
    refs.length,
  );

  const settled = await mapWithConcurrency(refs, limits.documentConcurrency, async (ref, index) => {
    const result = await readInSlice({
      ref,
      question,
      scope: depth === 'full' ? 'auto' : 'summary',
      index,
      total: refs.length,
      maxChapters,
      client: params.client,
      llm: params.llm,
      budget: params.budget,
      limits,
    });
    return result == null ? null : { ref, text: result.synthesis, source: result.source };
  });

  const rows: DochubExtractRow[] = [];
  const skipped: DochubDocumentRef[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled' && outcome.value != null) {
      rows.push(outcome.value);
      return;
    }
    if (outcome.status === 'rejected') {
      const reason = outcome.reason;
      if (reason instanceof DochubError && reason.kind === 'aborted') {
        throw reason;
      }
      if (!(reason instanceof DochubError && reason.kind === 'budget')) {
        logger.warn(`[dochub] extract could not read document ${refs[index].id}`, reason);
      }
    }
    skipped.push(refs[index]);
  });

  return { collectionName: params.collectionName, fields: [...fields], rows, skipped };
}

/** One compact block per document; each row gets an equal share of the result limit. */
export function formatExtractResult(
  result: DochubExtractResult,
  notes: readonly string[],
  limit: number,
): string {
  const total = result.rows.length + result.skipped.length;
  const lines = [
    `Коллекция «${result.collectionName}». Характеристик: ${result.fields.length}. Разобрано документов: ${result.rows.length} из ${total}.`,
  ];
  const share = Math.max(MIN_ROW_CHARS, Math.floor(limit / Math.max(1, result.rows.length)) - 80);
  for (const row of result.rows) {
    const closed = row.source === 'summary' ? ' (по выжимке)' : '';
    const text = row.text.trim().replace(/[ \t]+/g, ' ');
    const clipped = text.length <= share ? text : `${text.slice(0, share - 1)}…`;
    lines.push(`№${row.ref.seq} «${row.ref.title}»${closed}\n${clipped}`);
  }
  if (result.skipped.length > 0) {
    const list = result.skipped.map((ref) => `№${ref.seq}`).join(', ');
    lines.push(
      `⚠ Не разобраны (бюджет вызова или ошибка): ${list}. Повтори dochub_extract только для них, не выдумывай их данные.`,
    );
  }
  lines.push(...notes);
  return lines.join('\n\n');
}
