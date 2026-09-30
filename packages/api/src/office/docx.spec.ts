import JSZip from 'jszip';
import type { ToolMessage } from '@langchain/core/messages';
import type { IMongoFile } from '@librechat/data-schemas';
import type { GeneratedFile, GeneratedFilesArtifact } from './tool';
import type { DocxSpec } from './types';
import { createDocumentTool, documentFilename, GENERATED_FILES_ARTIFACT_KEY } from './tool';
import { toolDefinitions } from '~/tools/registry/definitions';
import { DOCX_LIMITS, parseDocumentInput } from './input';
import { buildDocument, DOCX_MIME_TYPE } from './docx';

const spec: DocxSpec = {
  title: 'Заявление на отпуск',
  blocks: [
    { type: 'paragraph', text: 'Генеральному директору\nООО «РН-Технологии»', align: 'right' },
    { type: 'heading', text: 'Заявление', align: 'center' },
    { type: 'paragraph', text: 'Прошу предоставить мне отпуск.', align: 'justify' },
    { type: 'list', items: ['Первый', 'Второй'], ordered: true },
    { type: 'table', header: ['Дата', 'Подпись'], rows: [['', '']] },
  ],
};

const documentXml = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file('word/document.xml')?.async('string')) ?? '';
};

describe('buildDocument', () => {
  it('produces a docx with text, alignment, list and table', async () => {
    const buffer = await buildDocument(spec);
    const xml = await documentXml(buffer);

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(xml).toContain('ООО «РН-Технологии»');
    expect(xml).toContain('w:jc w:val="right"');
    expect(xml).toContain('w:jc w:val="center"');
    expect(xml).toContain('<w:br/>');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:numPr>');
  });
});

describe('parseDocumentInput', () => {
  it('accepts stringified blocks and drops unknown ones', () => {
    const result = parseDocumentInput({
      title: 'T',
      blocks: JSON.stringify([{ type: 'paragraph', text: 'a' }, { type: 'nope' }]),
    });
    expect(result).toEqual({
      ok: true,
      spec: {
        title: 'T',
        filename: undefined,
        blocks: [
          { type: 'paragraph', text: 'a', align: undefined, bold: undefined, italic: undefined },
        ],
      },
    });
  });

  it('returns an actionable error when there are no usable blocks', () => {
    expect(parseDocumentInput({ title: 'T', blocks: [] })).toMatchObject({ ok: false });
    expect(parseDocumentInput({ title: 'T', blocks: 'oops' })).toMatchObject({ ok: false });
  });
});

describe('createDocumentTool', () => {
  const invoke = async (
    saveFile: (file: GeneratedFile) => Promise<IMongoFile>,
  ): Promise<ToolMessage> =>
    (await createDocumentTool({ saveFile }).invoke({
      id: 'call_1',
      name: 'create_document',
      args: spec,
      type: 'tool_call',
    })) as ToolMessage;

  it('saves the docx with a preview and returns the record as the artifact', async () => {
    const saved: GeneratedFile[] = [];
    const message = await invoke(async (file) => {
      saved.push(file);
      return { file_id: 'f1', filename: file.filename } as IMongoFile;
    });

    expect(saved[0].type).toBe(DOCX_MIME_TYPE);
    expect(saved[0].filename).toBe('Заявление_на_отпуск.docx');
    expect(saved[0].textFormat).toBe('html');
    expect(saved[0].text).toContain('Прошу предоставить');
    const artifact = message.artifact as GeneratedFilesArtifact;
    expect(artifact[GENERATED_FILES_ARTIFACT_KEY]).toHaveLength(1);
  });

  it('reports failure when storage throws', async () => {
    const message = await invoke(async () => {
      throw new Error('disk full');
    });
    expect(String(message.content)).toContain('Не удалось создать документ');
    expect(message.artifact).toEqual({});
  });
});

describe('create_document registration', () => {
  it('is registered as a builtin tool', () => {
    expect(toolDefinitions.create_document.toolType).toBe('builtin');
  });

  it('normalises the filename extension', () => {
    expect(documentFilename({ title: 'x', filename: 'a b.docx', blocks: [] })).toBe('a_b.docx');
  });
});

describe('large documents are never truncated', () => {
  const wide = (rows: number, columns: number): string[][] =>
    Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => `r${r}c${c}`));

  it('keeps every row and column of a 33x7 table', async () => {
    const header = Array.from({ length: 7 }, (_, c) => `h${c}`);
    const result = parseDocumentInput({
      title: 'T',
      blocks: [{ type: 'table', header, rows: wide(33, 7) }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const xml = await documentXml(await buildDocument(result.spec));
    expect(xml.match(/<w:tr>|<w:tr /g)).toHaveLength(34);
    expect(xml.match(/<w:tc>/g)).toHaveLength(34 * 7);
    expect(xml).toContain('r32c6');
  });

  it('keeps empty cells in place and pads short rows', () => {
    const result = parseDocumentInput({
      title: 'T',
      blocks: [{ type: 'table', header: ['a', 'b', 'c'], rows: [['1', null, '3'], ['x']] }],
    });
    expect(result).toMatchObject({
      ok: true,
      spec: {
        blocks: [
          {
            type: 'table',
            header: ['a', 'b', 'c'],
            rows: [
              ['1', '', '3'],
              ['x', '', ''],
            ],
          },
        ],
      },
    });
  });

  it('accepts a table without a header', () => {
    const result = parseDocumentInput({
      title: 'T',
      blocks: [{ type: 'table', rows: [['1', '2']] }],
    });
    expect(result).toMatchObject({
      ok: true,
      spec: { blocks: [{ type: 'table', header: [], rows: [['1', '2']] }] },
    });
  });

  it('refuses, rather than truncates, past the sanity limits', () => {
    const tooManyRows = parseDocumentInput({
      title: 'T',
      blocks: [{ type: 'table', header: ['a'], rows: wide(DOCX_LIMITS.rows + 1, 1) }],
    });
    expect(tooManyRows).toMatchObject({ ok: false });
    expect(tooManyRows.ok === false && tooManyRows.error).toContain('ничего не обрезано');

    const tooWide = parseDocumentInput({
      title: 'T',
      blocks: [{ type: 'table', header: wide(1, DOCX_LIMITS.columns + 1)[0], rows: [] }],
    });
    expect(tooWide).toMatchObject({ ok: false });

    const tooLong = parseDocumentInput({
      title: 'T',
      blocks: [{ type: 'list', items: wide(1, DOCX_LIMITS.items + 1)[0] }],
    });
    expect(tooLong).toMatchObject({ ok: false });
  });
});
