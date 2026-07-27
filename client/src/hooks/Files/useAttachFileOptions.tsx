import { useCallback, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { SharePointIcon } from '@librechat/client';
import {
  FileSearch,
  ImageUpIcon,
  FileType2Icon,
  FileImageIcon,
  TerminalSquareIcon,
} from 'lucide-react';
import {
  Providers,
  EToolResources,
  EModelEndpoint,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { FileLike, AttachFileUploadType } from '~/utils/attachFileDefaults';
import {
  normalizeProvider,
  getDefaultToolResource,
  providerSupportsNativeDocs,
} from '~/utils/attachFileDefaults';
import useAgentToolPermissions from '~/hooks/Agents/useAgentToolPermissions';
import useAgentCapabilities from '~/hooks/Agents/useAgentCapabilities';
import useGetAgentsConfig from '~/hooks/Agents/useGetAgentsConfig';
import { useGetStartupConfig } from '~/data-provider';
import { ephemeralAgentByConvoId } from '~/store';
import useLocalize from '~/hooks/useLocalize';

export interface AttachFileOption {
  key: 'provider' | 'context' | 'file_search' | 'execute_code' | 'sharepoint';
  label: string;
  icon: React.ReactNode;
  toolResource?: EToolResources;
  fileType?: AttachFileUploadType;
}

interface UseAttachFileOptionsParams {
  agentId?: string | null;
  endpoint?: string | null;
  endpointType?: string;
  conversationId?: string;
  useResponsesApi?: boolean;
  /** Drag-and-drop already has files in hand; SharePoint is an alternate file source and doesn't apply there. */
  includeSharePoint?: boolean;
}

/**
 * Single source of truth for the chat attach flow's smart-default decision and the
 * gated escape-hatch option list, shared by AttachFileMenu and DragDropModal.
 */
export default function useAttachFileOptions({
  agentId,
  endpoint,
  endpointType,
  conversationId,
  useResponsesApi,
  includeSharePoint = true,
}: UseAttachFileOptionsParams) {
  const localize = useLocalize();
  const { agentsConfig } = useGetAgentsConfig();
  /** TODO: Ephemeral Agent Capabilities
   * Allow defining agent capabilities on a per-endpoint basis
   * Use definition for agents endpoint for ephemeral agents
   * */
  const capabilities = useAgentCapabilities(agentsConfig?.capabilities ?? defaultAgentCapabilities);
  const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId ?? ''));
  const { fileSearchAllowedByAgent, codeAllowedByAgent, provider } = useAgentToolPermissions(
    agentId,
    ephemeralAgent,
  );
  const { data: startupConfig } = useGetStartupConfig();
  const sharePointEnabled = includeSharePoint && (startupConfig?.sharePointFilePickerEnabled ?? false);
  const showEscapeHatch = startupConfig?.interface?.fileAttachOptions !== false;

  const currentProvider = useMemo(
    () => normalizeProvider(provider || endpoint),
    [provider, endpoint],
  );

  const providerSupportsDocs = useMemo(
    () => providerSupportsNativeDocs({ currentProvider, endpointType, useResponsesApi }),
    [currentProvider, endpointType, useResponsesApi],
  );

  const resolveDefault = useCallback(
    (files: FileLike[]) =>
      getDefaultToolResource({
        files,
        endpoint,
        endpointType,
        provider,
        useResponsesApi,
        contextEnabled: capabilities.contextEnabled,
      }),
    [endpoint, endpointType, provider, useResponsesApi, capabilities.contextEnabled],
  );

  const overrideOptions = useMemo((): AttachFileOption[] => {
    const options: AttachFileOption[] = [];

    let providerFileType: Exclude<AttachFileUploadType, 'image' | 'document'> = 'image_document';
    if (currentProvider === Providers.GOOGLE || currentProvider === Providers.OPENROUTER) {
      providerFileType = 'image_document_video_audio';
    } else if (currentProvider === Providers.BEDROCK || endpointType === EModelEndpoint.bedrock) {
      providerFileType = 'image_document_extended';
    }

    options.push(
      providerSupportsDocs
        ? {
            key: 'provider',
            label: localize('com_ui_upload_provider'),
            icon: <FileImageIcon className="icon-md" />,
            fileType: providerFileType,
          }
        : {
            key: 'provider',
            label: localize('com_ui_upload_image_input'),
            icon: <ImageUpIcon className="icon-md" />,
            fileType: 'image',
          },
    );

    if (capabilities.contextEnabled) {
      options.push({
        key: 'context',
        label: localize('com_ui_upload_ocr_text'),
        icon: <FileType2Icon className="icon-md" />,
        toolResource: EToolResources.context,
      });
    }

    if (capabilities.fileSearchEnabled && fileSearchAllowedByAgent) {
      options.push({
        key: 'file_search',
        label: localize('com_ui_upload_file_search'),
        icon: <FileSearch className="icon-md" />,
        toolResource: EToolResources.file_search,
      });
    }

    if (capabilities.codeEnabled && codeAllowedByAgent) {
      options.push({
        key: 'execute_code',
        label: localize('com_ui_upload_code_environment'),
        icon: <TerminalSquareIcon className="icon-md" />,
        toolResource: EToolResources.execute_code,
      });
    }

    if (sharePointEnabled) {
      options.push({
        key: 'sharepoint',
        label: localize('com_files_upload_sharepoint'),
        icon: <SharePointIcon className="icon-md" />,
      });
    }

    return options;
  }, [
    localize,
    endpointType,
    currentProvider,
    capabilities,
    sharePointEnabled,
    codeAllowedByAgent,
    providerSupportsDocs,
    fileSearchAllowedByAgent,
  ]);

  return {
    resolveDefault,
    overrideOptions,
    showEscapeHatch,
    currentProvider,
    providerSupportsDocs,
    sharePointEnabled,
  };
}
