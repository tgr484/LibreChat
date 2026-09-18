import PptxGenJS from 'pptxgenjs';
import type {
  PresentationColumn,
  PresentationLayout,
  PresentationSlide,
  PresentationSpec,
  PresentationTable,
} from './types';
import { BRAND_ACCENT, BRAND_LOGO_PNG } from './brand';

export const PPTX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Minimalist theme: white slides, one muted accent, a single sans-serif face.
 * Calibri matches templates/template.pptx's font scheme and is metric-compatible
 * with LibreOffice's Carlito, so the layout holds on both without embedding fonts.
 */
const THEME = {
  font: 'Calibri',
  text: '1F2328',
  muted: '6B7280',
  accent: '2F5D8A',
  rule: 'D0D5DD',
  section: 'F3F4F6',
  background: 'FFFFFF',
} as const;

/** `LAYOUT_WIDE` is 13.333 × 7.5 in; every coordinate below is in inches. */
const PAGE = { width: 13.333, height: 7.5, margin: 0.7 } as const;
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
/** Text boxes pad their text by 0.1 in; accent bars start there to line up with it. */
const TEXT_INSET = 0.1;
const BODY_TOP = 1.55;
const FOOTER_TOP = 6.95;
const SOURCES_TOP = 6.35;

const MASTER = 'LC_MINIMAL';
const SECTION_MASTER = 'LC_MINIMAL_SECTION';

/**
 * Geometry lifted from templates/template.pptx (a 10 × 5.625 in canvas) and
 * scaled ×1.3333 onto this deck's 13.333 × 7.5 in `LAYOUT_WIDE` canvas so the
 * wordmark and corner swatch land in the same proportional spot.
 */
const LOGO = { x: 11.78, y: 0.4, w: 1.11, h: 0.37 } as const;
const CORNER_ACCENT = { x: 0, y: PAGE.height - 0.59, w: 0.59, h: 0.59 } as const;

function addBrandMarks(objects: NonNullable<PptxGenJS.SlideMasterProps['objects']>): void {
  objects.push(
    {
      rect: {
        ...CORNER_ACCENT,
        fill: { color: BRAND_ACCENT },
        line: { color: BRAND_ACCENT, width: 0 },
      },
    },
    { image: { ...LOGO, data: BRAND_LOGO_PNG } },
  );
}

type TextRun = PptxGenJS.TextProps;
type TableRow = PptxGenJS.TableRow;
type CellBorder = [
  PptxGenJS.BorderProps,
  PptxGenJS.BorderProps,
  PptxGenJS.BorderProps,
  PptxGenJS.BorderProps,
];

/** Denser text gets a smaller size instead of overflowing the slide. */
function bodyFontSize(lines: readonly string[]): number {
  const chars = lines.reduce((total, line) => total + line.length, 0);
  if (chars <= 350 && lines.length <= 5) {
    return 22;
  }
  if (chars <= 500 && lines.length <= 6) {
    return 20;
  }
  if (chars <= 650 && lines.length <= 7) {
    return 18;
  }
  return chars <= 950 ? 16 : 14;
}

function bulletRuns(bullets: readonly string[], fontSize: number): TextRun[] {
  return bullets.map((text) => ({
    text,
    options: {
      bullet: { indent: fontSize * 0.9 },
      breakLine: true,
      paraSpaceAfter: fontSize * 0.6,
    },
  }));
}

function defineMasters(pptx: PptxGenJS, footer: string): void {
  const footerText = {
    text: {
      text: footer,
      options: {
        x: PAGE.margin,
        y: FOOTER_TOP,
        w: CONTENT_WIDTH - 1,
        h: 0.3,
        fontFace: THEME.font,
        fontSize: 10,
        color: THEME.muted,
      },
    },
  };
  const slideNumber = {
    x: PAGE.width - PAGE.margin - 0.6,
    y: FOOTER_TOP,
    w: 0.6,
    h: 0.3,
    fontFace: THEME.font,
    fontSize: 10,
    color: THEME.muted,
    align: 'right' as const,
  };

  const masterObjects: NonNullable<PptxGenJS.SlideMasterProps['objects']> = [
    {
      line: {
        x: PAGE.margin,
        y: FOOTER_TOP - 0.08,
        w: CONTENT_WIDTH,
        h: 0,
        line: { color: THEME.rule, width: 0.75 },
      },
    },
    footerText,
  ];
  addBrandMarks(masterObjects);

  pptx.defineSlideMaster({
    title: MASTER,
    background: { color: THEME.background },
    objects: masterObjects,
    slideNumber,
  });

  const sectionObjects: NonNullable<PptxGenJS.SlideMasterProps['objects']> = [footerText];
  addBrandMarks(sectionObjects);

  pptx.defineSlideMaster({
    title: SECTION_MASTER,
    background: { color: THEME.section },
    objects: sectionObjects,
    slideNumber,
  });
}

function addTitle(slide: PptxGenJS.Slide, title: string): void {
  slide.addText(title, {
    x: PAGE.margin,
    y: 0.45,
    w: CONTENT_WIDTH,
    h: 0.85,
    fontFace: THEME.font,
    fontSize: title.length > 60 ? 24 : 28,
    bold: true,
    color: THEME.text,
    valign: 'bottom',
    fit: 'shrink',
  });
  slide.addShape('rect', {
    x: PAGE.margin + TEXT_INSET,
    y: 1.34,
    w: 0.8,
    h: 0.06,
    fill: { color: THEME.accent },
    line: { color: THEME.accent, width: 0 },
  });
}

function addSources(slide: PptxGenJS.Slide, sources: readonly string[] | undefined): number {
  if (!sources?.length) {
    return FOOTER_TOP - 0.25;
  }
  slide.addText(`Источники: ${sources.join('; ')}`, {
    x: PAGE.margin,
    y: SOURCES_TOP,
    w: CONTENT_WIDTH,
    h: 0.45,
    fontFace: THEME.font,
    fontSize: 10,
    italic: true,
    color: THEME.muted,
    valign: 'bottom',
    fit: 'shrink',
  });
  return SOURCES_TOP - 0.1;
}

function addBulletBox(
  slide: PptxGenJS.Slide,
  bullets: readonly string[],
  box: { x: number; y: number; w: number; h: number },
  fontSize = bodyFontSize(bullets),
): void {
  if (bullets.length === 0) {
    return;
  }
  slide.addText(bulletRuns(bullets, fontSize), {
    ...box,
    fontFace: THEME.font,
    fontSize,
    color: THEME.text,
    valign: 'top',
    fit: 'shrink',
  });
}

function addColumn(
  slide: PptxGenJS.Slide,
  column: PresentationColumn | undefined,
  x: number,
  width: number,
  bottom: number,
  fontSize: number,
): void {
  if (!column) {
    return;
  }
  let top = BODY_TOP + 0.05;
  if (column.heading) {
    slide.addText(column.heading, {
      x,
      y: top,
      w: width,
      h: 0.5,
      fontFace: THEME.font,
      fontSize: fontSize + 2,
      bold: true,
      color: THEME.accent,
      valign: 'top',
      fit: 'shrink',
    });
    top += 0.6;
  }
  addBulletBox(slide, column.bullets, { x, y: top, w: width, h: bottom - top }, fontSize);
}

function tableRows(table: PresentationTable): TableRow[] {
  const width = table.header.length;
  const headerBorder: CellBorder = [
    { type: 'none' },
    { type: 'none' },
    { type: 'solid', color: THEME.accent, pt: 1.5 },
    { type: 'none' },
  ];
  const rowBorder: CellBorder = [
    { type: 'none' },
    { type: 'none' },
    { type: 'solid', color: THEME.rule, pt: 0.75 },
    { type: 'none' },
  ];
  const header: TableRow = table.header.map((text) => ({
    text,
    options: { bold: true, color: THEME.text, border: headerBorder },
  }));
  const body: TableRow[] = table.rows.map((row) =>
    Array.from({ length: width }, (_, index) => ({
      text: row[index] ?? '',
      options: { color: THEME.text, border: rowBorder },
    })),
  );
  return [header, ...body];
}

/** Column widths follow the longest cell, so a page-number column stays narrow. */
function columnWidths(table: PresentationTable): number[] {
  const weights = table.header.map((header, index) => {
    const longest = table.rows.reduce(
      (max, row) => Math.max(max, (row[index] ?? '').length),
      header.length,
    );
    return Math.min(Math.max(longest, 6), 60);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => (weight / total) * CONTENT_WIDTH);
}

function tableFontSize(table: PresentationTable): number {
  const cells = table.header.length * (table.rows.length + 1);
  const chars = [table.header, ...table.rows].flat().reduce((sum, cell) => sum + cell.length, 0);
  if (cells <= 24 && chars <= 500) {
    return 16;
  }
  return chars <= 1000 ? 13 : 11;
}

function renderContent(
  slide: PptxGenJS.Slide,
  layout: PresentationLayout,
  spec: PresentationSlide,
  bottom: number,
): void {
  if (layout === 'two_columns') {
    const gap = 0.6;
    const width = (CONTENT_WIDTH - gap) / 2;
    const fontSize = bodyFontSize([...(spec.left?.bullets ?? []), ...(spec.right?.bullets ?? [])]);
    addColumn(slide, spec.left, PAGE.margin, width, bottom, fontSize);
    addColumn(slide, spec.right, PAGE.margin + width + gap, width, bottom, fontSize);
    return;
  }
  if (layout === 'table' && spec.table && spec.table.header.length > 0) {
    slide.addTable(tableRows(spec.table), {
      x: PAGE.margin,
      y: BODY_TOP + 0.1,
      w: CONTENT_WIDTH,
      colW: columnWidths(spec.table),
      fontFace: THEME.font,
      fontSize: tableFontSize(spec.table),
      valign: 'middle',
      margin: [0.06, 0.1, 0.06, 0.1],
    });
    return;
  }
  addBulletBox(slide, spec.bullets ?? [], {
    x: PAGE.margin,
    y: BODY_TOP + 0.1,
    w: CONTENT_WIDTH,
    h: bottom - BODY_TOP - 0.1,
  });
}

function addTitleSlide(pptx: PptxGenJS, spec: PresentationSpec): void {
  const slide = pptx.addSlide();
  slide.background = { color: THEME.background };
  slide.addShape('rect', {
    ...CORNER_ACCENT,
    fill: { color: BRAND_ACCENT },
    line: { color: BRAND_ACCENT, width: 0 },
  });
  slide.addImage({ ...LOGO, data: BRAND_LOGO_PNG });
  slide.addShape('rect', {
    x: PAGE.margin + TEXT_INSET,
    y: 2.35,
    w: 1.1,
    h: 0.08,
    fill: { color: THEME.accent },
    line: { color: THEME.accent, width: 0 },
  });
  slide.addText(spec.title, {
    x: PAGE.margin,
    y: 2.6,
    w: CONTENT_WIDTH,
    h: 1.6,
    fontFace: THEME.font,
    fontSize: spec.title.length > 70 ? 32 : 40,
    bold: true,
    color: THEME.text,
    valign: 'top',
    fit: 'shrink',
  });
  if (spec.subtitle) {
    slide.addText(spec.subtitle, {
      x: PAGE.margin,
      y: 4.3,
      w: CONTENT_WIDTH,
      h: 1,
      fontFace: THEME.font,
      fontSize: 20,
      color: THEME.muted,
      valign: 'top',
      fit: 'shrink',
    });
  }
}

function addSectionSlide(pptx: PptxGenJS, spec: PresentationSlide): PptxGenJS.Slide {
  const slide = pptx.addSlide({ masterName: SECTION_MASTER });
  slide.addShape('rect', {
    x: PAGE.margin + TEXT_INSET,
    y: 3.05,
    w: 0.8,
    h: 0.06,
    fill: { color: THEME.accent },
    line: { color: THEME.accent, width: 0 },
  });
  slide.addText(spec.title, {
    x: PAGE.margin,
    y: 3.25,
    w: CONTENT_WIDTH,
    h: 1.2,
    fontFace: THEME.font,
    fontSize: 34,
    bold: true,
    color: THEME.text,
    valign: 'top',
    fit: 'shrink',
  });
  const [lead] = spec.bullets ?? [];
  if (lead) {
    slide.addText(lead, {
      x: PAGE.margin,
      y: 4.5,
      w: CONTENT_WIDTH,
      h: 0.9,
      fontFace: THEME.font,
      fontSize: 18,
      color: THEME.muted,
      valign: 'top',
      fit: 'shrink',
    });
  }
  return slide;
}

function addContentSlide(
  pptx: PptxGenJS,
  layout: PresentationLayout,
  spec: PresentationSlide,
): PptxGenJS.Slide {
  const slide = pptx.addSlide({ masterName: MASTER });
  addTitle(slide, spec.title);
  renderContent(slide, layout, spec, addSources(slide, spec.sources));
  return slide;
}

function addSlide(pptx: PptxGenJS, spec: PresentationSlide): void {
  const layout = spec.layout ?? 'bullets';
  const slide =
    layout === 'section' ? addSectionSlide(pptx, spec) : addContentSlide(pptx, layout, spec);
  if (spec.notes) {
    slide.addNotes(spec.notes);
  }
}

/** Builds the deck: a title slide, then one slide per entry of `spec.slides`. */
export async function buildPresentation(spec: PresentationSpec): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = spec.title;
  pptx.theme = { headFontFace: THEME.font, bodyFontFace: THEME.font };
  defineMasters(pptx, spec.title);

  addTitleSlide(pptx, spec);
  spec.slides.forEach((slide) => addSlide(pptx, slide));

  const output = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}
