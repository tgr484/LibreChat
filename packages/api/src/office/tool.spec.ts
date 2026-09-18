import type { ToolMessage } from '@langchain/core/messages';
import type { IMongoFile } from '@librechat/data-schemas';
import type { GeneratedFile, GeneratedFilesArtifact } from './tool';
import type { PresentationSpec } from './types';
import {
  presentationFilename,
  normalizePresentation,
  createPresentationTool,
  GENERATED_FILES_ARTIFACT_KEY,
} from './tool';
import { toolDefinitions } from '~/tools/registry/definitions';
import { officeToolkit } from '~/tools/toolkits/office';
import { PPTX_MIME_TYPE } from './pptx';

const spec: PresentationSpec = {
  title: 'Итоги испытаний',
  subtitle: 'Сентябрь 2026',
  slides: [{ title: 'Главное', bullets: ['- КПД выше расчётного', '', '• Вибрация в норме'] }],
};

const invoke = async (
  args: PresentationSpec,
  saveFile: (file: GeneratedFile) => Promise<IMongoFile>,
): Promise<ToolMessage> =>
  (await createPresentationTool({ saveFile }).invoke({
    id: 'call_1',
    name: 'create_presentation',
    args,
    type: 'tool_call',
  })) as ToolMessage;

describe('createPresentationTool', () => {
  it('saves the deck with its preview and returns the stored record as the artifact', async () => {
    const saved: GeneratedFile[] = [];
    const message = await invoke(spec, async (file) => {
      saved.push(file);
      return { file_id: 'f1', filename: file.filename } as IMongoFile;
    });

    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe(PPTX_MIME_TYPE);
    expect(saved[0].filename).toBe('Итоги_испытаний.pptx');
    expect(saved[0].buffer.subarray(0, 2).toString()).toBe('PK');
    expect(saved[0].textFormat).toBe('html');
    expect(saved[0].text).toContain('Вибрация в норме');

    const artifact = message.artifact as GeneratedFilesArtifact;
    expect(artifact[GENERATED_FILES_ARTIFACT_KEY]).toEqual([
      { file_id: 'f1', filename: 'Итоги_испытаний.pptx' },
    ]);
    expect(String(message.content)).toContain('2 слайдов');
  });

  it('tells the model the file was not created when storage fails', async () => {
    const message = await invoke(spec, async () => {
      throw new Error('disk full');
    });

    expect(String(message.content)).toContain('Не удалось создать презентацию');
    expect(message.artifact).toEqual({});
  });
});

describe('normalizePresentation', () => {
  it('drops list markers and empty bullets the layout would duplicate', () => {
    const [slide] = normalizePresentation(spec).slides;
    expect(slide.bullets).toEqual(['КПД выше расчётного', 'Вибрация в норме']);
  });

  it('keeps a number and its unit on one line', () => {
    const [slide] = normalizePresentation({
      ...spec,
      slides: [{ title: 'Режим', bullets: ['Подогрев ниже −30 °C, запас 5 %'] }],
    }).slides;
    expect(slide.bullets).toEqual(['Подогрев ниже −30\u00A0°C, запас 5\u00A0%']);
  });
});

describe('presentationFilename', () => {
  it('prefers the requested name and keeps a single extension', () => {
    expect(presentationFilename({ ...spec, filename: 'отчёт.pptx' })).toBe('отчёт.pptx');
  });

  it('strips path components from a requested name', () => {
    expect(presentationFilename({ ...spec, filename: '../../etc/passwd' })).toBe('passwd.pptx');
  });
});

describe('create_presentation registration', () => {
  /** Without the artifact response format the attachment never reaches the chat. */
  it('declares content_and_artifact in the registry the graph reads', () => {
    const definition = toolDefinitions.create_presentation;
    expect(definition.responseFormat).toBe('content_and_artifact');
    expect(definition.schema).toBe(officeToolkit.create_presentation.schema);
  });
});
