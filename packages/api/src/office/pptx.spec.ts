import JSZip from 'jszip';
import type { PresentationSpec } from './types';
import { bufferToOfficeHtml } from '~/files/documents/html';
import { buildPresentation, PPTX_MIME_TYPE } from './pptx';

const spec: PresentationSpec = {
  title: 'Испытания турбодетандеров',
  subtitle: 'Обзор коллекции «Нефтяное хозяйство 2018»',
  slides: [
    {
      title: 'Главное',
      bullets: ['КПД выше расчётного на 3–5 %', 'Вибрация в пределах нормы'],
      sources: ['№3 «Испытания турбодетандера», с. 41'],
      notes: 'Начать с результатов, методику — позже.',
    },
    { layout: 'section', title: 'Методика', bullets: ['Как проводились испытания'] },
    {
      layout: 'two_columns',
      title: 'Стенд и промысел',
      left: { heading: 'Стенд', bullets: ['Полный контроль режимов'] },
      right: { heading: 'Промысел', bullets: ['Реальный состав газа'] },
    },
    {
      layout: 'table',
      title: 'Результаты',
      table: {
        header: ['Документ', 'КПД, %'],
        rows: [
          ['№3', '84'],
          ['№7', '81'],
        ],
      },
    },
  ],
};

const slideXml = async (buffer: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  return Promise.all(names.map((name) => zip.file(name)!.async('string')));
};

describe('buildPresentation', () => {
  it('writes a title slide followed by one slide per entry', async () => {
    const buffer = await buildPresentation(spec);
    const slides = await slideXml(buffer);

    expect(slides).toHaveLength(5);
    expect(slides[0]).toContain('Испытания турбодетандеров');
    expect(slides[0]).toContain('Обзор коллекции');
    expect(slides[1]).toContain('КПД выше расчётного');
    expect(slides[1]).toContain('Источники: №3 «Испытания турбодетандера», с. 41');
    expect(slides[3]).toContain('Реальный состав газа');
    expect(slides[4]).toContain('<a:tbl>');
  });

  it('keeps speaker notes off the slide', async () => {
    const buffer = await buildPresentation(spec);
    const zip = await JSZip.loadAsync(buffer);
    const [slides, notes] = await Promise.all([
      slideXml(buffer),
      zip.file('ppt/notesSlides/notesSlide2.xml')!.async('string'),
    ]);

    expect(notes).toContain('Начать с результатов');
    expect(slides[1]).not.toContain('Начать с результатов');
  });

  /** The preview the chat shows is rendered from the same bytes the user downloads. */
  it('renders the office preview the attachment card shows', async () => {
    const buffer = await buildPresentation(spec);
    const html = await bufferToOfficeHtml(buffer, 'deck.pptx', PPTX_MIME_TYPE);

    expect(html).not.toBeNull();
    expect(html).toContain('Испытания турбодетандеров');
    expect(html).toContain('Стенд и промысел');
    expect(html).toContain('Вибрация в пределах нормы');
  });
});
