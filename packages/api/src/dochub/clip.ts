const CUT_MARKER = '\n…(ответ обрезан)';

/**
 * A sentence ends before a capital letter, a quote, a bracketed citation or
 * the end of a line — not before a digit, so «9 час. 00 мин.» is never split.
 */
const BOUNDARY = /[.!?…»\])](?=[ \t]+[A-ZА-ЯЁ«[]|[ \t]*\n)|\n/g;

/**
 * Fits a tool answer into the limit, cutting at the last whole sentence or
 * line: a split list item or a figure would mislead the chat model.
 */
export function clipAnswer(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const room = text.slice(0, Math.max(0, limit - CUT_MARKER.length));
  let end = -1;
  for (const match of room.matchAll(BOUNDARY)) {
    end = (match.index ?? 0) + match[0].length;
  }
  const kept = end > room.length / 2 ? room.slice(0, end) : room;
  return `${kept.trimEnd()}${CUT_MARKER}`;
}
