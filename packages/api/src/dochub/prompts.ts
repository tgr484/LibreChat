import type {
  DochubChapter,
  DochubCitation,
  DochubReadResult,
  DochubChapterFinding,
} from './types';

/** The one answer the extraction prompt allows when a fragment is irrelevant. */
export const NO_DATA = 'НЕТ ДАННЫХ';

const pages = (from: number | null, to: number | null): string => {
  if (from == null) {
    return 'страницы не размечены';
  }
  return from === to || to == null ? `с. ${from}` : `с. ${from}–${to}`;
};

/** A section-cited document has one logical page: its number tells the model nothing. */
const span = (citation: DochubCitation, from: number | null, to: number | null): string =>
  citation === 'page' ? ` (${pages(from, to)})` : '';

const TEXT_NOTE: Record<DochubCitation, string> = {
  page: 'В тексте есть маркеры страниц вида <!-- page: N -->.',
  section: 'Номеров страниц у документа нет — ссылайся на пункты и разделы.',
};

const EXTRACT_REFERENCE: Record<DochubCitation, string> = {
  page: 'После каждого утверждения укажи страницу по ближайшему предшествующему маркеру в виде (с. N).',
  section:
    'После каждого утверждения укажи номер пункта или раздела документа в виде (п. 5.2), а если номера нет — его название в виде (раздел «Название»).',
};

/** A paraphrase bends numbers: «45 минут в промежутке 12–15» became «с 12 до 15». */
const VERBATIM =
  'Числа, время, сроки, суммы и условия приводи дословной цитатой в кавычках — не пересказывай их.';
const VERBATIM_LOWER =
  'числа, время, сроки, суммы и условия — только дословно, вместе с поясняющими словами.';

const sectionReference = (seq: number): string =>
  `Ссылку вида [№${seq}, п. N] (номер пункта или раздела; если номера нет — [№${seq}, раздел «Название»]) ставь сразу после каждого утверждения.`;

export function extractionPrompt(params: {
  citation: DochubCitation;
  title: string;
  heading: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  question: string;
  limit: number;
  text: string;
}): string {
  const heading = params.heading ? `, глава «${params.heading}»` : '';
  return `Ты — помощник-исследователь. Ниже фрагмент документа «${params.title}»${heading}${span(params.citation, params.pageFrom, params.pageTo)}. ${TEXT_NOTE[params.citation]}

Вопрос: «${params.question}»

Выпиши ТОЛЬКО то, что относится к вопросу: факты, числа с единицами, условия, методы, выводы, определения. ${EXTRACT_REFERENCE[params.citation]} Короткие дословные цитаты бери в кавычки; ${VERBATIM_LOWER} Ничего не додумывай и не обобщай сверх текста. Не более ${params.limit} символов. Отвечай на русском языке.

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
  citation: DochubCitation;
  seq: number;
  title: string;
  question: string;
  limit: number;
  text: string;
}): string {
  const reference =
    params.citation === 'page'
      ? `Ссылку вида [№${params.seq}, с. N] (по ближайшему предшествующему маркеру страницы) ставь сразу после каждого утверждения.`
      : sectionReference(params.seq);
  return `Ты — помощник-исследователь. Ниже полный текст документа №${params.seq} «${params.title}». ${TEXT_NOTE[params.citation]}

Вопрос: «${params.question}»

Составь ответ на вопрос строго по тексту:
1. Связное изложение, 5–12 предложений. ${reference}
2. Отдельный список подтверждений не добавляй.
3. ${VERBATIM}
4. Ничего не додумывай сверх текста.
Не более ${params.limit} символов. Отвечай на русском языке.

Если в тексте нет ничего по вопросу, ответь ровно: ${NO_DATA}

--- ТЕКСТ ---
${params.text}`;
}

export function selectionPrompt(params: {
  citation: DochubCitation;
  title: string;
  question: string;
  chapters: readonly DochubChapter[];
  count: number;
}): string {
  const outline = params.chapters
    .map(
      (chapter) =>
        `${chapter.index}. ${chapter.heading ?? '(без заголовка)'} — ${params.citation === 'page' ? `${pages(chapter.page_from, chapter.page_to)}, ` : ''}${chapter.chars} симв.`,
    )
    .join('\n');
  return `Документ «${params.title}» состоит из ${params.chapters.length} частей. Нужно выбрать части, полезные для ответа на вопрос.

Вопрос: «${params.question}»

Оглавление (номер. заголовок — ${params.citation === 'page' ? 'страницы, ' : ''}объём):
${outline}

Верни ТОЛЬКО номера частей через запятую, от самых полезных к менее полезным, не более ${params.count}. Без пояснений.`;
}

export function documentReducePrompt(params: {
  citation: DochubCitation;
  seq: number;
  title: string;
  question: string;
  limit: number;
  findings: readonly DochubChapterFinding[];
}): string {
  const body = params.findings
    .map((finding) => {
      const heading = finding.heading ? ` «${finding.heading}»` : '';
      return `### Часть ${finding.chapterIndex}${heading}${span(params.citation, finding.pageFrom, finding.pageTo)}\n${finding.text}`;
    })
    .join('\n\n');
  const paged = params.citation === 'page';
  const reference = paged
    ? `Ссылку вида [№${params.seq}, с. N] ставь сразу после каждого утверждения.`
    : sectionReference(params.seq);
  return `Вопрос: «${params.question}»

Ниже выписки из частей документа №${params.seq} «${params.title}» ${paged ? 'с номерами страниц' : 'со ссылками на пункты'}.

Составь ответ на вопрос строго по выпискам:
1. Связное изложение, 5–12 предложений. ${reference}
2. Отдельный список подтверждений не добавляй.
3. ${VERBATIM}
4. Если части документа противоречат друг другу, отметь это.
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
Каждое утверждение сопровождай ссылкой вида [№N «Название», с. X] или [№N «Название», п. X] — номера, страницы и пункты бери только из разборов, в том виде, как они там указаны. Не добавляй сведений, которых нет в разборах. Не более ${params.limit} символов. Отвечай на русском языке.

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
