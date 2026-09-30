import type { DochubChapter, DochubChapterFinding, DochubReadResult } from './types';

/** The one answer the extraction prompt allows when a fragment is irrelevant. */
export const NO_DATA = 'НЕТ ДАННЫХ';

const pages = (from: number | null, to: number | null): string => {
  if (from == null) {
    return 'страницы не размечены';
  }
  return from === to || to == null ? `с. ${from}` : `с. ${from}–${to}`;
};

export function extractionPrompt(params: {
  title: string;
  heading: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  question: string;
  limit: number;
  text: string;
}): string {
  const heading = params.heading ? `, глава «${params.heading}»` : '';
  return `Ты — помощник-исследователь. Ниже фрагмент документа «${params.title}»${heading} (${pages(params.pageFrom, params.pageTo)}). В тексте есть маркеры страниц вида <!-- page: N -->.

Вопрос: «${params.question}»

Выпиши ТОЛЬКО то, что относится к вопросу: факты, числа с единицами, условия, методы, выводы, определения. После каждого утверждения укажи страницу по ближайшему предшествующему маркеру в виде (с. N). Короткие дословные цитаты бери в кавычки. Ничего не додумывай и не обобщай сверх текста. Не более ${params.limit} символов. Отвечай на русском языке.

Если во фрагменте нет ничего по вопросу, ответь ровно: ${NO_DATA}

--- ТЕКСТ ---
${params.text}`;
}

export function summaryPrompt(params: {
  title: string;
  question: string;
  limit: number;
  summary: string;
}): string {
  return `Ты — помощник-исследователь. Ниже выжимка документа «${params.title}» (полный текст недоступен).

Вопрос: «${params.question}»

Выпиши из выжимки только то, что относится к вопросу. Ничего не додумывай. Не более ${params.limit} символов. Отвечай на русском языке.
Если в выжимке нет ничего по вопросу, ответь ровно: ${NO_DATA}

--- ВЫЖИМКА ---
${params.summary}`;
}

export function fullDocumentPrompt(params: {
  seq: number;
  title: string;
  question: string;
  limit: number;
  text: string;
}): string {
  return `Ты — помощник-исследователь. Ниже полный текст документа №${params.seq} «${params.title}». В тексте есть маркеры страниц вида <!-- page: N -->.

Вопрос: «${params.question}»

Составь ответ на вопрос строго по тексту:
1. Связное изложение, 5–12 предложений. Ссылку вида [№${params.seq}, с. N] (по ближайшему предшествующему маркеру страницы) ставь сразу после каждого утверждения.
2. Отдельный список подтверждений не добавляй.
3. Ничего не додумывай сверх текста.
Не более ${params.limit} символов. Отвечай на русском языке.

Если в тексте нет ничего по вопросу, ответь ровно: ${NO_DATA}

--- ТЕКСТ ---
${params.text}`;
}

export function selectionPrompt(params: {
  title: string;
  question: string;
  chapters: readonly DochubChapter[];
  count: number;
}): string {
  const outline = params.chapters
    .map(
      (chapter) =>
        `${chapter.index}. ${chapter.heading ?? '(без заголовка)'} — ${pages(chapter.page_from, chapter.page_to)}, ${chapter.chars} симв.`,
    )
    .join('\n');
  return `Документ «${params.title}» состоит из ${params.chapters.length} частей. Нужно выбрать части, полезные для ответа на вопрос.

Вопрос: «${params.question}»

Оглавление (номер. заголовок — страницы, объём):
${outline}

Верни ТОЛЬКО номера частей через запятую, от самых полезных к менее полезным, не более ${params.count}. Без пояснений.`;
}

export function documentReducePrompt(params: {
  seq: number;
  title: string;
  question: string;
  limit: number;
  findings: readonly DochubChapterFinding[];
}): string {
  const body = params.findings
    .map((finding) => {
      const heading = finding.heading ? ` «${finding.heading}»` : '';
      return `### Часть ${finding.chapterIndex}${heading} (${pages(finding.pageFrom, finding.pageTo)})\n${finding.text}`;
    })
    .join('\n\n');
  return `Вопрос: «${params.question}»

Ниже выписки из частей документа №${params.seq} «${params.title}» с номерами страниц.

Составь ответ на вопрос строго по выпискам:
1. Связное изложение, 5–12 предложений. Ссылку вида [№${params.seq}, с. N] ставь сразу после каждого утверждения.
2. Отдельный список подтверждений не добавляй.
3. Если части документа противоречат друг другу, отметь это.
Не добавляй сведений, которых нет в выписках. Не более ${params.limit} символов. Отвечай на русском языке.

--- ВЫПИСКИ ---
${body}`;
}

export function surveyReducePrompt(params: {
  collection: string;
  question: string;
  limit: number;
  documents: readonly Pick<DochubReadResult, 'ref' | 'synthesis' | 'source'>[];
}): string {
  const body = params.documents
    .map((document) => {
      const closed = document.source === 'summary' ? ' (только выжимка)' : '';
      return `### №${document.ref.seq} «${document.ref.title}»${closed}\n${document.synthesis}`;
    })
    .join('\n\n');
  return `Вопрос: «${params.question}»

Ниже разборы ${params.documents.length} документов коллекции «${params.collection}», каждый помечен номером и названием.

Составь сводку:
1. Что документы говорят по вопросу — связно, 3–6 абзацев.
2. В чём документы сходятся и в чём расходятся; чего в них не хватает для ответа.
Каждое утверждение сопровождай ссылкой вида [№N «Название», с. X] — номера и страницы бери только из разборов. Не добавляй сведений, которых нет в разборах. Не более ${params.limit} символов. Отвечай на русском языке.

--- РАЗБОРЫ ---
${body}`;
}

/** Selection answers are free text; only valid, unique chapter indices survive. */
export function parseSelection(answer: string, chapterCount: number, limit: number): number[] {
  const seen = new Set<number>();
  for (const match of answer.matchAll(/\d+/g)) {
    const index = Number(match[0]);
    if (index < chapterCount && !seen.has(index)) {
      seen.add(index);
    }
    if (seen.size >= limit) {
      break;
    }
  }
  return [...seen];
}

export function isNoData(answer: string): boolean {
  return answer.trim().replace(/[.!]$/, '').toUpperCase() === NO_DATA;
}
