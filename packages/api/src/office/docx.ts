import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ParagraphChild } from 'docx';
import type {
  DocxAlign,
  DocxBlock,
  DocxHeading,
  DocxList,
  DocxParagraph,
  DocxSpec,
  DocxTable,
} from './types';
import { DOCX_MIME_TYPE } from '~/files/mime';

export { DOCX_MIME_TYPE };

/** Times New Roman 14 pt, the default for Russian business correspondence. */
const FONT = 'Times New Roman';
const BODY_SIZE = 28;
const HEADING_SIZE: Record<number, number> = { 1: 32, 2: 30, 3: 28 };
const HEADING_LEVEL = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;
const ALIGNMENT: Record<DocxAlign, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};
const BULLET_REF = 'bullets';
const NUMBER_REF = 'numbers';
const LINE_BREAK = /\r?\n/;

/** A soft line break inside one paragraph, so address blocks and signature lines stay together. */
const runs = (
  text: string,
  options: { bold?: boolean; italics?: boolean; size?: number } = {},
): ParagraphChild[] =>
  text.split(LINE_BREAK).map(
    (line, index) =>
      new TextRun({
        text: line,
        break: index === 0 ? undefined : 1,
        font: FONT,
        size: options.size ?? BODY_SIZE,
        bold: options.bold,
        italics: options.italics,
      }),
  );

const heading = ({ text, level = 1, align }: DocxHeading): Paragraph[] => [
  new Paragraph({
    heading: HEADING_LEVEL[level],
    alignment: ALIGNMENT[align ?? 'left'],
    spacing: { before: 240, after: 120 },
    children: runs(text, { bold: true, size: HEADING_SIZE[level] }),
  }),
];

const paragraph = ({ text, align, bold, italic }: DocxParagraph): Paragraph[] => [
  new Paragraph({
    alignment: ALIGNMENT[align ?? 'left'],
    spacing: { after: 120 },
    children: runs(text, { bold, italics: italic }),
  }),
];

const list = ({ items, ordered }: DocxList): Paragraph[] =>
  items.map(
    (item) =>
      new Paragraph({
        numbering: { reference: ordered ? NUMBER_REF : BULLET_REF, level: 0 },
        children: runs(item),
      }),
  );

const cell = (text: string, bold: boolean): TableCell =>
  new TableCell({ children: [new Paragraph({ children: runs(text, { bold, size: 24 }) })] });

const table = ({ header, rows }: DocxTable): Array<Paragraph | Table> => [
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (header.length > 0 ? [header, ...rows] : rows).map(
      (row, index) =>
        new TableRow({
          tableHeader: header.length > 0 && index === 0,
          children: row.map((text) => cell(text, header.length > 0 && index === 0)),
        }),
    ),
  }),
  new Paragraph({ children: [] }),
];

const BUILDERS: {
  [K in DocxBlock['type']]: (block: Extract<DocxBlock, { type: K }>) => Array<Paragraph | Table>;
} = {
  heading,
  paragraph,
  list,
  table,
};

const renderBlock = (block: DocxBlock): Array<Paragraph | Table> =>
  (BUILDERS[block.type] as (value: DocxBlock) => Array<Paragraph | Table>)(block);

const numberingLevel = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: string) => ({
  level: 0,
  format,
  text,
  alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: 720, hanging: 360 } } },
});

export async function buildDocument(spec: DocxSpec): Promise<Buffer> {
  const document = new Document({
    title: spec.title,
    styles: { default: { document: { run: { font: FONT, size: BODY_SIZE } } } },
    numbering: {
      config: [
        { reference: BULLET_REF, levels: [numberingLevel(LevelFormat.BULLET, '•')] },
        { reference: NUMBER_REF, levels: [numberingLevel(LevelFormat.DECIMAL, '%1.')] },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1134, bottom: 1134, left: 1701, right: 850 } },
        },
        children: spec.blocks.flatMap(renderBlock),
      },
    ],
  });
  return Packer.toBuffer(document);
}
