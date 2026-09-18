import { NO_DATA, isNoData, parseSelection, extractionPrompt } from './prompts';
import { extractText, stripReasoning } from './llm';

describe('parseSelection', () => {
  it('keeps valid, unique chapter numbers in the model order', () => {
    expect(parseSelection('17, 4, 99, 4, 2', 20, 3)).toEqual([17, 4, 2]);
  });

  it('returns nothing for an answer without numbers', () => {
    expect(parseSelection('не могу выбрать', 20, 3)).toEqual([]);
  });
});

describe('isNoData', () => {
  it('accepts the marker with stray punctuation or case', () => {
    expect(isNoData(NO_DATA)).toBe(true);
    expect(isNoData(' нет данных. ')).toBe(true);
    expect(isNoData('Нет данных о давлении, но есть о температуре')).toBe(false);
  });
});

describe('extractionPrompt', () => {
  it('carries the question, the pages and the text', () => {
    const prompt = extractionPrompt({
      title: 'Отчёт',
      heading: 'Введение',
      pageFrom: 3,
      pageTo: 5,
      question: 'Какое давление?',
      limit: 1200,
      text: '<!-- page: 3 -->\nдавление 12 МПа',
    });

    expect(prompt).toContain('«Отчёт», глава «Введение» (с. 3–5)');
    expect(prompt).toContain('Вопрос: «Какое давление?»');
    expect(prompt).toContain(`ответь ровно: ${NO_DATA}`);
    expect(prompt.endsWith('давление 12 МПа')).toBe(true);
  });
});

describe('extractText', () => {
  it('reads plain and multi-part content', () => {
    expect(extractText('ответ')).toBe('ответ');
    expect(extractText([{ type: 'text', text: 'а' }, 'б', { type: 'image' }])).toBe('аб');
    expect(extractText(undefined)).toBe('');
  });
});

describe('stripReasoning', () => {
  it('drops leaked thinking, including an orphan closing tag', () => {
    expect(stripReasoning('<think>рассуждаю</think>\nОтвет')).toBe('Ответ');
    expect(stripReasoning('рассуждаю</think>Ответ')).toBe('Ответ');
    expect(stripReasoning('Ответ')).toBe('Ответ');
  });
});
