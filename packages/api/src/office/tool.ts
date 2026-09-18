import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { IMongoFile } from '@librechat/data-schemas';
import type { PresentationColumn, PresentationSlide, PresentationSpec } from './types';
import { bufferToOfficeHtml } from '~/files/documents/html';
import { buildPresentation, PPTX_MIME_TYPE } from './pptx';
import { officeToolkit } from '~/tools/toolkits/office';
import { sanitizeFilename } from '~/utils/files';

/**
 * Artifact key for files a tool has already persisted. The tool-end callback
 * only has to stamp the run ids onto each record and stream it as an attachment.
 */
export const GENERATED_FILES_ARTIFACT_KEY = '__librechat_generated_files';

export interface GeneratedFile {
  buffer: Buffer;
  filename: string;
  type: string;
  /** Office preview HTML, or null when it could not be rendered. */
  text: string | null;
  textFormat: 'html' | null;
}

/** Persists a generated file in the configured storage; injected by `/api`. */
export type SaveGeneratedFile = (file: GeneratedFile) => Promise<IMongoFile>;

export interface GeneratedFilesArtifact {
  [GENERATED_FILES_ARTIFACT_KEY]?: IMongoFile[];
}

const FILENAME_STEM_MAX = 80;
const BULLET_MARKER = /^\s*(?:[-–—•*·]|\d+[.)])\s+/;

/** Keeps «−30 °C» and «5 %» on one line. */
const UNIT_SPACE = /(\d) (?=%|°)/g;

const cleanBullets = (bullets: readonly string[] | undefined): string[] =>
  (bullets ?? [])
    .map((bullet) => bullet.replace(BULLET_MARKER, '').replace(UNIT_SPACE, '$1\u00A0').trim())
    .filter(Boolean);

const cleanColumn = (column: PresentationColumn | undefined): PresentationColumn | undefined =>
  column
    ? { heading: column.heading?.trim() || undefined, bullets: cleanBullets(column.bullets) }
    : undefined;

const cleanSlide = (slide: PresentationSlide): PresentationSlide => ({
  ...slide,
  title: slide.title.trim(),
  bullets: cleanBullets(slide.bullets),
  left: cleanColumn(slide.left),
  right: cleanColumn(slide.right),
  sources: slide.sources?.map((source) => source.trim()).filter(Boolean),
  notes: slide.notes?.trim() || undefined,
});

/** Models send list markers and blank lines anyway; the layout supplies its own. */
export const normalizePresentation = (spec: PresentationSpec): PresentationSpec => ({
  ...spec,
  title: spec.title.trim(),
  subtitle: spec.subtitle?.trim() || undefined,
  slides: spec.slides.map(cleanSlide),
});

export const presentationFilename = (spec: PresentationSpec): string => {
  const stem = (spec.filename || spec.title)
    .replace(/\.pptx$/i, '')
    .replace(/\s+/g, '_')
    .slice(0, FILENAME_STEM_MAX);
  return sanitizeFilename(`${stem || 'presentation'}.pptx`);
};

async function renderPreview(buffer: Buffer, filename: string): Promise<string | null> {
  try {
    return await bufferToOfficeHtml(buffer, filename, PPTX_MIME_TYPE);
  } catch (error) {
    logger.warn('[create_presentation] preview rendering failed', error);
    return null;
  }
}

const describeResult = (spec: PresentationSpec, filename: string): string =>
  `Презентация «${spec.title}» создана: ${spec.slides.length + 1} слайдов, включая титульный. Файл ${filename} прикреплён к ответу — пользователь скачает его из карточки файла. Не пересказывай слайды целиком: кратко опиши структуру и предложи, что можно доработать.`;

export interface CreatePresentationToolParams {
  saveFile: SaveGeneratedFile;
}

export function createPresentationTool({
  saveFile,
}: CreatePresentationToolParams): DynamicStructuredTool {
  const definition = officeToolkit.create_presentation;
  return tool(
    async (input: PresentationSpec): Promise<[string, GeneratedFilesArtifact]> => {
      const spec = normalizePresentation(input);
      const filename = presentationFilename(spec);
      try {
        const buffer = await buildPresentation(spec);
        const text = await renderPreview(buffer, filename);
        const file = await saveFile({
          buffer,
          filename,
          type: PPTX_MIME_TYPE,
          text,
          textFormat: text == null ? null : 'html',
        });
        return [describeResult(spec, filename), { [GENERATED_FILES_ARTIFACT_KEY]: [file] }];
      } catch (error) {
        logger.error('[create_presentation] failed to build the presentation', error);
        return [
          'Не удалось создать презентацию из-за ошибки на сервере. Сообщи пользователю, что файл не создан, и предложи повторить позже.',
          {},
        ];
      }
    },
    {
      name: definition.name,
      description: definition.description,
      schema: definition.schema,
      responseFormat: definition.responseFormat,
    },
  ) as DynamicStructuredTool;
}
