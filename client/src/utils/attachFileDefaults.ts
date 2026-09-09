import {
  Providers,
  EToolResources,
  EModelEndpoint,
  inferMimeType,
  fullMimeTypesList,
  isBedrockDocumentType,
  bedrockDocumentExtensions,
  isDocumentSupportedProvider,
} from 'librechat-data-provider';
import type { RegexLike } from 'librechat-data-provider';

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

/** Shape needed once `provider || endpoint` has already been resolved to a single normalized value. */
export interface NormalizedProviderContext {
  currentProvider?: string;
  endpointType?: string | null;
  useResponsesApi?: boolean;
}

export const isAzureResponsesApi = ({
  currentProvider,
  endpointType,
  useResponsesApi,
}: NormalizedProviderContext): boolean =>
  (currentProvider === EModelEndpoint.azureOpenAI || endpointType === EModelEndpoint.azureOpenAI) &&
  useResponsesApi === true;

export const providerSupportsNativeDocs = (
  { currentProvider, endpointType, useResponsesApi }: NormalizedProviderContext,
  /** A custom endpoint's underlying model may not actually support native document input;
   * once OCR is configured, prefer it over guessing (see `getDefaultToolResource`). */
  contextEnabled = false,
): boolean => {
  if (endpointType === EModelEndpoint.custom && contextEnabled) {
    return false;
  }
  return (
    isDocumentSupportedProvider(endpointType) ||
    isDocumentSupportedProvider(currentProvider) ||
    isAzureResponsesApi({ currentProvider, endpointType, useResponsesApi })
  );
};

/** Whether a single file can be sent natively to the active provider (vision/native document understanding), with no server-side text/OCR extraction. */
export const isFileValidForProvider = (
  file: FileLike,
  { currentProvider, endpointType, useResponsesApi }: NormalizedProviderContext,
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
  const isBedrock =
    currentProvider === Providers.BEDROCK || endpointType === EModelEndpoint.bedrock;
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
 *
 * Custom endpoints are a special case: `EModelEndpoint.custom` is in `documentSupportedProviders`
 * because many OpenAI-compatible custom configs do support native PDFs. However we cannot know
 * at this point whether the specific underlying model actually does. When OCR is available
 * (`contextEnabled`) and the user is on a custom endpoint, prefer OCR for non-image files so
 * that configured OCR strategies (e.g. an ocr-shim server) are used by default. The escape-hatch
 * override menu still allows forcing native upload when the underlying model truly supports it.
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

  if (endpointType === EModelEndpoint.custom && contextEnabled) {
    const allImages = files.every((file) => {
      const type = inferMimeType(file.name, file.type);
      return type?.startsWith('image/') ?? false;
    });
    return allImages ? undefined : EToolResources.context;
  }

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

/**
 * OS file-picker `accept` filter for the smart-default upload, derived from the endpoint's
 * configured `supportedMimeTypes` patterns (`librechat.yaml` `fileConfig`). Patterns are regexes
 * and `accept` only understands literal extensions/MIME types, so each pattern is matched against
 * LibreChat's known MIME type list to build the concrete filter; an explicitly permissive config
 * (e.g. `.*`) is handled separately by the caller via `isPermissiveMimeConfig`.
 */
export const getAcceptFromSupportedMimeTypes = (supportedMimeTypes?: RegexLike[]): string => {
  if (!supportedMimeTypes || supportedMimeTypes.length === 0) {
    return '';
  }
  return fullMimeTypesList
    .filter((mimeType) => supportedMimeTypes.some((regex) => regex.test(mimeType)))
    .join(',');
};
