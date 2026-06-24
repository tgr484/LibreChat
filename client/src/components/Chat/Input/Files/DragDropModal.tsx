import { useState, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { OGDialog, OGDialogTemplate } from '@librechat/client';
import { EToolResources } from 'librechat-data-provider';
import { useAttachFileOptions } from '~/hooks';
import { useDragDropContext } from '~/Providers';
import useLocalize from '~/hooks/useLocalize';
import { cn } from '~/utils';

interface DragDropModalProps {
  onOptionSelect: (option: EToolResources | undefined) => void;
  files: File[];
  isVisible: boolean;
  setShowModal: (showModal: boolean) => void;
}

const DragDropModal = ({ onOptionSelect, setShowModal, files, isVisible }: DragDropModalProps) => {
  const localize = useLocalize();
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const { conversationId, agentId, endpoint, endpointType, useResponsesApi } =
    useDragDropContext();

  const { resolveDefault, overrideOptions, showEscapeHatch } = useAttachFileOptions({
    agentId,
    endpoint,
    endpointType,
    conversationId,
    useResponsesApi,
    includeSharePoint: false,
  });

  const recommendedToolResource = useMemo(() => resolveDefault(files), [resolveDefault, files]);
  const recommendedKey = recommendedToolResource === EToolResources.context ? 'context' : 'provider';
  const recommendedOption = overrideOptions.find((option) => option.key === recommendedKey);
  const otherOptions = overrideOptions.filter((option) => option.key !== recommendedKey);

  if (!isVisible) {
    return null;
  }

  return (
    <OGDialog open={isVisible} onOpenChange={setShowModal}>
      <OGDialogTemplate
        title={localize('com_ui_upload_type')}
        className="w-11/12 sm:w-[440px] md:w-[400px] lg:w-[360px]"
        main={
          <div className="flex flex-col gap-2">
            {recommendedOption && (
              <button
                onClick={() => onOptionSelect(recommendedToolResource)}
                className="flex items-center gap-2 rounded-lg border border-border-light bg-surface-active-alt p-2 hover:bg-surface-hover"
              >
                {recommendedOption.icon}
                <span>{recommendedOption.label}</span>
                <span className="ml-auto text-xs text-text-secondary">
                  {localize('com_ui_recommended')}
                </span>
              </button>
            )}
            {showEscapeHatch && otherOptions.length > 0 && (
              <>
                <button
                  onClick={() => setShowMoreOptions((prev) => !prev)}
                  className="flex items-center gap-1 self-start p-1 text-sm text-text-secondary hover:text-text-primary"
                >
                  {localize('com_ui_more_options')}
                  <ChevronDown
                    className={cn(
                      'icon-sm transition-transform duration-200',
                      showMoreOptions && 'rotate-180',
                    )}
                    aria-hidden="true"
                  />
                </button>
                {showMoreOptions &&
                  otherOptions.map((option) => (
                    <button
                      key={option.key}
                      onClick={() => onOptionSelect(option.toolResource)}
                      className="flex items-center gap-2 rounded-lg p-2 hover:bg-surface-active-alt"
                    >
                      {option.icon}
                      <span>{option.label}</span>
                    </button>
                  ))}
              </>
            )}
          </div>
        }
      />
    </OGDialog>
  );
};

export default DragDropModal;
