import React, { useRef, useMemo, useState, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import { FileUpload } from '@librechat/client';
import { EToolResources, isPermissiveMimeConfig } from 'librechat-data-provider';
import type { EndpointFileConfig, TConversation } from 'librechat-data-provider';
import type { SharePointFile } from '~/data-provider/Files/sharepoint';
import type { AttachFileOption } from '~/hooks/Files/useAttachFileOptions';
import type { ExtendedFile, FileSetter } from '~/common';
import { getAcceptForFileType } from '~/utils/attachFileDefaults';
import {
  useAttachFileOptions,
  useFileHandlingNoChatContext,
  useLocalize,
} from '~/hooks';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { SharePointPickerDialog } from '~/components/SharePoint';
import { ephemeralAgentByConvoId } from '~/store';
import AttachFileButton from './AttachFileButton';

interface AttachFileMenuProps {
  agentId?: string | null;
  endpoint?: string | null;
  disabled?: boolean | null;
  conversationId: string;
  endpointType?: string;
  endpointFileConfig?: EndpointFileConfig;
  useResponsesApi?: boolean;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: TConversation | null;
}

const AttachFileMenu = ({
  agentId,
  endpoint,
  disabled,
  endpointType,
  conversationId,
  endpointFileConfig,
  useResponsesApi,
  files,
  setFiles,
  setFilesLoading,
  conversation,
}: AttachFileMenuProps) => {
  const localize = useLocalize();
  const isUploadDisabled = disabled ?? false;
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadFileTooltip = useShortcutHint('uploadFile', localize('com_sidepanel_attach_files'));
  const uploadFileAriaKey = useShortcutAriaKey('uploadFile');
  const [, setEphemeralAgent] = useRecoilState(ephemeralAgentByConvoId(conversationId));
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);

  /** `null` defers the decision to the smart default (resolved from the picked files); any other
   * value means an escape-hatch item was explicitly clicked and should be used as-is. */
  const toolResourceRef = useRef<EToolResources | undefined | null>(null);

  const { handleFileChange } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });
  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(undefined, {
      files,
      setFiles,
      setFilesLoading,
      conversation,
    });

  const { resolveDefault, overrideOptions, showEscapeHatch } = useAttachFileOptions({
    agentId,
    endpoint,
    endpointType,
    conversationId,
    useResponsesApi,
  });

  const openInputWithAccept = useCallback(
    (fileType?: AttachFileOption['fileType']) => {
      if (!inputRef.current) {
        return;
      }
      inputRef.current.value = '';
      inputRef.current.accept = isPermissiveMimeConfig(endpointFileConfig?.supportedMimeTypes)
        ? ''
        : getAcceptForFileType(fileType);
      inputRef.current.click();
    },
    [endpointFileConfig?.supportedMimeTypes],
  );

  const handlePrimaryClick = useCallback(() => {
    toolResourceRef.current = null;
    openInputWithAccept(undefined);
  }, [openInputWithAccept]);

  const handleOverrideSelect = useCallback(
    (option: AttachFileOption) => {
      if (option.key === 'sharepoint') {
        setIsSharePointDialogOpen(true);
        return;
      }
      if (option.key === 'file_search' || option.key === 'execute_code') {
        setEphemeralAgent((prev) => ({ ...prev, [option.toolResource as EToolResources]: true }));
      }
      toolResourceRef.current = option.toolResource;
      openInputWithAccept(option.fileType);
    },
    [openInputWithAccept, setEphemeralAgent],
  );

  const menuItems = useMemo(
    () =>
      overrideOptions.map((option) => ({
        label: option.label,
        icon: option.icon,
        onClick: () => handleOverrideSelect(option),
      })),
    [overrideOptions, handleOverrideSelect],
  );

  const handleSharePointFilesSelected = async (sharePointFiles: SharePointFile[]) => {
    try {
      const toolResource = resolveDefault(
        sharePointFiles.map((file) => ({ name: file.name, type: '' })),
      );
      await handleSharePointFiles(sharePointFiles, toolResource);
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };

  return (
    <>
      <FileUpload
        ref={inputRef}
        handleFileChange={(e) => {
          const selectedFiles = e.target.files ? Array.from(e.target.files) : [];
          const toolResource =
            toolResourceRef.current === null
              ? resolveDefault(selectedFiles)
              : toolResourceRef.current;
          handleFileChange(e, toolResource);
          toolResourceRef.current = null;
        }}
      >
        <AttachFileButton
          disabled={isUploadDisabled}
          tooltip={uploadFileTooltip}
          ariaKeyShortcut={uploadFileAriaKey}
          onPrimaryClick={handlePrimaryClick}
          overrideItems={menuItems}
          showEscapeHatch={showEscapeHatch}
        />
      </FileUpload>
      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
        maxSelectionCount={endpointFileConfig?.fileLimit}
      />
    </>
  );
};

export default React.memo(AttachFileMenu);
