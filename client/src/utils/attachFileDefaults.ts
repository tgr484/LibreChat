import {
  Providers,
  EToolResources,
  EModelEndpoint,
  inferMimeType,
  isBedrockDocumentType,
  bedrockDocumentExtensions,
  isDocumentSupportedProvider,
} from 'librechat-data-provider';

export type AttachFileUploadType =
  | 'image'
  | 'document'
  | 'image_document'
  | 'image_document_extended'
  | 'image_document_video_audio';

export interface ProviderUploadContext {
  endpoint?: string | null;
  endpointType?: string | null;
  provider?: string;
  useResponsesApi?: boolean;
}

/** Minimal shape needed to classify a file's MIME type — satisfied by both browser `File` objects and pre-download remote file references (e.g. SharePoint picks). */
export interface FileLike {
  name: string;
  type: string;
}

/** Normalizes provider casing for comparisons; OpenRouter is matched case-insensitively. */
export const normalizeProvider = (provider?: string | null): string | undefined => {
  if (provider == null || provider === '') {
    return undefined;
  }
  if (provider.toLowerCase() === Providers.OPENROUTER) {
    return Providers.OPENROUTER;
  }
  return provider;
};

export const isAzureResponsesApi = ({
  currentProvider,
  endpointType,
  useResponsesApi,
}: {
  currentProvider?: string;
  endpointType?: string | null;
  useResponsesApi?: boolean;
}): boolean =>
  (currentProvider === EModelEndpoint.azureOpenAI || endpointType === EModelEndpoint.azureOpenAI) &&
  useResponsesApi === true;

export const providerSupportsNativeDocs = ({
  currentProvider,
  endpointType,
  useResponsesApi,
}: {
  currentProvider?: string;
  endpointType?: string | null;
  useResponsesApi?: boolean;
}): boolean =>
  isDocumentSupportedProvider(endpointType) ||
  isDocumentSupportedProvider(currentProvider) ||
  isAzureResponsesApi({ currentProvider, endpointType, useResponsesApi });

/** Whether a single file can be sent natively to the active provider (vision/native document understanding), with no server-side text/OCR extraction. */
export const isFileValidForProvider = (
  file: FileLike,
  { currentProvider, endpointType, useResponsesApi }: ProviderUploadContext,
): boolean => {
  const type = inferMimeType(file.name, file.type);
  if (!type) {
    return false;
  }
  if (!providerSupportsNativeDocs({ currentProvider, endpointType, useResponsesApi })) {
    return type.startsWith('image/');
  }
  const supportsImageDocVideoAudio =
    currentProvider === EModelEndpoint.google || currentProvider === Providers.OPENROUTER;
  if (supportsImageDocVideoAudio) {
    return (
      type.startsWith('image/') ||
      type.startsWith('video/') ||
      type.startsWith('audio/') ||
      type === 'application/pdf'
    );
  }
  const isBedrock = currentProvider === Providers.BEDROCK || endpointType === EModelEndpoint.bedrock;
  if (isBedrock) {
    return type.startsWith('image/') || isBedrockDocumentType(type);
  }
  return type.startsWith('image/') || type === 'application/pdf';
};

/**
 * Decides the smart-default `tool_resource` for a batch of files (one decision per batch,
 * matching the existing batch-oriented `handleFiles`/`validateFiles` architecture):
 * native/provider upload if every file is natively supported by the active provider,
 * otherwise OCR/text-extraction (`context`) if that capability is enabled, otherwise
 * fall back to native and let existing validation/backend errors surface unsupported types.
 */
export const getDefaultToolResource = ({
  files,
  endpoint,
  endpointType,
  provider,
  useResponsesApi,
  contextEnabled,
}: ProviderUploadContext & {
  files: FileLike[];
  contextEnabled: boolean;
}): EToolResources | undefined => {
  const currentProvider = normalizeProvider(provider || endpoint);
  const allNativelyValid = files.every((file) =>
    isFileValidForProvider(file, { currentProvider, endpointType, useResponsesApi }),
  );
  if (allNativelyValid) {
    return undefined;
  }
  if (contextEnabled) {
    return EToolResources.context;
  }
  return undefined;
};

/** OS file-picker `accept` filter for an explicit (escape-hatch) upload-type choice. */
export const getAcceptForFileType = (fileType?: AttachFileUploadType): string => {
  switch (fileType) {
    case 'image':
      return 'image/*,.heif,.heic';
    case 'document':
      return '.pdf,application/pdf';
    case 'image_document':
      return 'image/*,.heif,.heic,.pdf,application/pdf';
    case 'image_document_extended':
      return `image/*,.heif,.heic,${bedrockDocumentExtensions}`;
    case 'image_document_video_audio':
      return 'image/*,.heif,.heic,.pdf,application/pdf,video/*,audio/*';
    default:
      return '';
  }
};
