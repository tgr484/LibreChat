import { EModelEndpoint, EToolResources, Providers } from 'librechat-data-provider';
import { getDefaultToolResource, isFileValidForProvider } from '../attachFileDefaults';

function makeFile(name: string, type: string): File {
  return new File([new ArrayBuffer(8)], name, { type });
}

describe('isFileValidForProvider', () => {
  it('allows images for a provider with no native document support', () => {
    const file = makeFile('photo.png', 'image/png');
    expect(isFileValidForProvider(file, { currentProvider: EModelEndpoint.openAI })).toBe(true);
  });

  it('rejects non-images for a provider with no native document support', () => {
    const file = makeFile('doc.pdf', 'application/pdf');
    expect(isFileValidForProvider(file, { currentProvider: EModelEndpoint.openAI })).toBe(false);
  });

  it('allows pdf for a document-supported provider (anthropic)', () => {
    const file = makeFile('doc.pdf', 'application/pdf');
    expect(isFileValidForProvider(file, { currentProvider: EModelEndpoint.anthropic })).toBe(true);
  });

  it('allows audio/video for google', () => {
    const audio = makeFile('clip.mp3', 'audio/mpeg');
    const video = makeFile('clip.mp4', 'video/mp4');
    expect(isFileValidForProvider(audio, { currentProvider: EModelEndpoint.google })).toBe(true);
    expect(isFileValidForProvider(video, { currentProvider: EModelEndpoint.google })).toBe(true);
  });

  it('allows a bedrock-supported document type (xls) for bedrock', () => {
    const file = makeFile('sheet.xls', 'application/vnd.ms-excel');
    expect(isFileValidForProvider(file, { currentProvider: Providers.BEDROCK })).toBe(true);
  });

  it('rejects a document type bedrock does not support (pptx)', () => {
    const file = makeFile(
      'slides.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(isFileValidForProvider(file, { currentProvider: Providers.BEDROCK })).toBe(false);
  });

  it('allows azure document upload only when useResponsesApi is true', () => {
    const file = makeFile('doc.pdf', 'application/pdf');
    expect(
      isFileValidForProvider(file, {
        currentProvider: EModelEndpoint.azureOpenAI,
        useResponsesApi: false,
      }),
    ).toBe(false);
    expect(
      isFileValidForProvider(file, {
        currentProvider: EModelEndpoint.azureOpenAI,
        useResponsesApi: true,
      }),
    ).toBe(true);
  });
});

describe('getDefaultToolResource', () => {
  it('returns undefined (native) when every file is natively supported', () => {
    const files = [makeFile('photo.png', 'image/png')];
    const result = getDefaultToolResource({
      files,
      provider: EModelEndpoint.openAI,
      contextEnabled: true,
    });
    expect(result).toBeUndefined();
  });

  it('returns context when a file is not natively supported but context is enabled', () => {
    const files = [makeFile('doc.docx', 'application/vnd.ms-word')];
    const result = getDefaultToolResource({
      files,
      provider: EModelEndpoint.openAI,
      contextEnabled: true,
    });
    expect(result).toBe(EToolResources.context);
  });

  it('falls back to native when no safe default exists (context disabled)', () => {
    const files = [makeFile('doc.docx', 'application/vnd.ms-word')];
    const result = getDefaultToolResource({
      files,
      provider: EModelEndpoint.openAI,
      contextEnabled: false,
    });
    expect(result).toBeUndefined();
  });

  it('requires every file in the batch to be natively valid to pick native', () => {
    const files = [makeFile('photo.png', 'image/png'), makeFile('doc.docx', 'application/vnd.ms-word')];
    const result = getDefaultToolResource({
      files,
      provider: EModelEndpoint.openAI,
      contextEnabled: true,
    });
    expect(result).toBe(EToolResources.context);
  });
});
