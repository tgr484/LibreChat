import {
  EModelEndpoint,
  EToolResources,
  Providers,
  imageMimeTypes,
  applicationMimeTypes,
} from 'librechat-data-provider';
import {
  getDefaultToolResource,
  isFileValidForProvider,
  getAcceptFromSupportedMimeTypes,
} from '../attachFileDefaults';

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

  describe('custom endpoint', () => {
    it('routes PDF to OCR when contextEnabled (ocr-shim / unknown native support)', () => {
      const files = [makeFile('doc.pdf', 'application/pdf')];
      const result = getDefaultToolResource({
        files,
        endpoint: 'ocr-shim',
        endpointType: EModelEndpoint.custom,
        contextEnabled: true,
      });
      expect(result).toBe(EToolResources.context);
    });

    it('routes images natively even on custom endpoint with contextEnabled', () => {
      const files = [makeFile('photo.png', 'image/png')];
      const result = getDefaultToolResource({
        files,
        endpoint: 'ocr-shim',
        endpointType: EModelEndpoint.custom,
        contextEnabled: true,
      });
      expect(result).toBeUndefined();
    });

    it('falls back to native when contextEnabled is false on custom endpoint', () => {
      const files = [makeFile('doc.pdf', 'application/pdf')];
      const result = getDefaultToolResource({
        files,
        endpoint: 'my-custom-endpoint',
        endpointType: EModelEndpoint.custom,
        contextEnabled: false,
      });
      expect(result).toBeUndefined();
    });

    it('routes a mixed batch (image + PDF) to OCR on custom endpoint with contextEnabled', () => {
      const files = [makeFile('photo.png', 'image/png'), makeFile('doc.pdf', 'application/pdf')];
      const result = getDefaultToolResource({
        files,
        endpoint: 'my-custom-endpoint',
        endpointType: EModelEndpoint.custom,
        contextEnabled: true,
      });
      expect(result).toBe(EToolResources.context);
    });
  });
});

describe('getAcceptFromSupportedMimeTypes', () => {
  it('returns no restriction when no config is given', () => {
    expect(getAcceptFromSupportedMimeTypes(undefined)).toBe('');
    expect(getAcceptFromSupportedMimeTypes([])).toBe('');
  });

  it('limits the accept filter to the configured MIME categories', () => {
    const accept = getAcceptFromSupportedMimeTypes([imageMimeTypes]);
    expect(accept).toContain('image/png');
    expect(accept).toContain('image/jpeg');
    expect(accept).not.toContain('application/pdf');
    expect(accept).not.toContain('video/mp4');
  });

  it('combines multiple configured categories', () => {
    const accept = getAcceptFromSupportedMimeTypes([imageMimeTypes, applicationMimeTypes]);
    expect(accept).toContain('image/png');
    expect(accept).toContain('application/pdf');
    expect(accept).not.toContain('video/mp4');
  });
});
