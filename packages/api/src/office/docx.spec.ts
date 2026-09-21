import JSZip from 'jszip';
import type { ToolMessage } from '@langchain/core/messages';
import type { IMongoFile } from '@librechat/data-schemas';
import type { GeneratedFile, GeneratedFilesArtifact } from './tool';
import type { DocxSpec } from './types';
import { createDocumentTool, documentFilename, GENERATED_FILES_ARTIFACT_KEY } from './tool';
import { toolDefinitions } from '~/tools/registry/definitions';
import { buildDocument, DOCX_MIME_TYPE } from './docx';
import { parseDocumentInput } from './input';

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
