import { clipAnswer } from './clip';

describe('clipAnswer', () => {
  it('leaves an answer within the limit untouched', () => {
    expect(clipAnswer('Короткий ответ.', 100)).toBe('Короткий ответ.');
  });

  it('cuts at the last whole sentence and marks the cut', () => {
    const text = `Первое предложение. Второе предложение. ${'Третье очень длинное '.repeat(5)}`;
    const clipped = clipAnswer(text, 70);

    expect(clipped).toBe('Первое предложение. Второе предложение.\n…(ответ обрезан)');
    expect(clipped.length).toBeLessThanOrEqual(70);
  });

  it('keeps list items whole', () => {
    const text = '- «Статья 1» — с. 44\n- «Статья 2» — с. 77\n- «Статья 3» — с. 82–87';
    expect(clipAnswer(text, 60)).toBe(
      '- «Статья 1» — с. 44\n- «Статья 2» — с. 77\n…(ответ обрезан)',
    );
  });

  it('never splits «9 час. 00 мин.» as a sentence end', () => {
    const text =
      'Начало в 9 час. 00 мин. и окончание в 18 час. 00 мин. для всех работников компании';
    expect(clipAnswer(text, 60)).not.toMatch(/9 час\.\n/);
  });
});
