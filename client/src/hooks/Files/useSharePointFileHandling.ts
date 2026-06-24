import { useRef, useCallback } from 'react';
import type { EModelEndpoint } from 'librechat-data-provider';
import type { SharePointFile } from '~/data-provider/Files/sharepoint';
import type { FileHandlingState } from './useFileHandling';
import useFileHandling, { useFileHandlingNoChatContext } from './useFileHandling';
import useSharePointDownload from './useSharePointDownload';

interface UseSharePointFileHandlingProps {
  fileSetter?: any;
  toolResource?: string;
  fileFilter?: (file: File) => boolean;
  additionalMetadata?: Record<string, string | undefined>;
  endpointOverride?: EModelEndpoint | string;
  endpointTypeOverride?: EModelEndpoint | string;
}

interface UseSharePointFileHandlingReturn {
  /** `toolResource` overrides the hook's configured default for this call only — resolved synchronously before the download starts, so callers can decide it from the picked files (e.g. the smart-default decision) without depending on render timing. */
  handleSharePointFiles: (files: SharePointFile[], toolResource?: string) => Promise<void>;
  isProcessing: boolean;
  downloadProgress: any;
  error: string | null;
}

export default function useSharePointFileHandling(
  props?: UseSharePointFileHandlingProps,
): UseSharePointFileHandlingReturn {
  const { handleFiles } = useFileHandling(props);
  const toolResourceOverrideRef = useRef<string | undefined>(undefined);
  const { downloadSharePointFiles, isDownloading, downloadProgress, error } = useSharePointDownload(
    {
      onFilesDownloaded: async (downloadedFiles: File[]) => {
        const fileArray = Array.from(downloadedFiles);
        await handleFiles(fileArray, toolResourceOverrideRef.current ?? props?.toolResource);
      },
      onError: (error) => {
        console.error('SharePoint download failed:', error);
      },
    },
  );

  const handleSharePointFiles = useCallback(
    async (sharePointFiles: SharePointFile[], toolResource?: string) => {
      toolResourceOverrideRef.current = toolResource;
      try {
        await downloadSharePointFiles(sharePointFiles);
      } catch (error) {
        console.error('SharePoint file handling error:', error);
        throw error;
      } finally {
        toolResourceOverrideRef.current = undefined;
      }
    },
    [downloadSharePointFiles],
  );

  return {
    handleSharePointFiles,
    isProcessing: isDownloading,
    downloadProgress,
    error,
  };
}

export function useSharePointFileHandlingNoChatContext(
  props: UseSharePointFileHandlingProps | undefined,
  fileState: FileHandlingState,
): UseSharePointFileHandlingReturn {
  const { handleFiles } = useFileHandlingNoChatContext(props, fileState);
  const toolResourceOverrideRef = useRef<string | undefined>(undefined);

  const { downloadSharePointFiles, isDownloading, downloadProgress, error } = useSharePointDownload(
    {
      onFilesDownloaded: async (downloadedFiles: File[]) => {
        const fileArray = Array.from(downloadedFiles);
        await handleFiles(fileArray, toolResourceOverrideRef.current ?? props?.toolResource);
      },
      onError: (error) => {
        console.error('SharePoint download failed:', error);
      },
    },
  );

  const handleSharePointFiles = useCallback(
    async (sharePointFiles: SharePointFile[], toolResource?: string) => {
      toolResourceOverrideRef.current = toolResource;
      try {
        await downloadSharePointFiles(sharePointFiles);
      } catch (error) {
        console.error('SharePoint file handling error:', error);
        throw error;
      } finally {
        toolResourceOverrideRef.current = undefined;
      }
    },
    [downloadSharePointFiles],
  );

  return {
    handleSharePointFiles,
    isProcessing: isDownloading,
    downloadProgress,
    error,
  };
}
