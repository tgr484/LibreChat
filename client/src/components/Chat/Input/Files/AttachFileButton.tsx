import { useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { ChevronDown } from 'lucide-react';
import { TooltipAnchor, DropdownPopup, AttachmentIcon } from '@librechat/client';
import type { MenuItemProps } from '~/common';
import { cn } from '~/utils';

interface AttachFileButtonProps {
  disabled?: boolean;
  tooltip: string;
  ariaKeyShortcut?: string;
  onPrimaryClick: () => void;
  overrideItems: MenuItemProps[];
  showEscapeHatch: boolean;
}

/**
 * Split button: the paperclip immediately performs the smart-default upload; the
 * chevron (hidden when `interface.fileAttachOptions` is disabled) exposes the
 * escape-hatch menu of explicit overrides (Force Provider/Text, File Search,
 * Code Environment, SharePoint).
 */
const AttachFileButton = ({
  disabled,
  tooltip,
  ariaKeyShortcut,
  onPrimaryClick,
  overrideItems,
  showEscapeHatch,
}: AttachFileButtonProps) => {
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const hasEscapeHatch = showEscapeHatch && overrideItems.length > 0;

  const primaryButton = (
    <button
      type="button"
      id="attach-file-button"
      aria-label="Attach File Options"
      aria-keyshortcuts={ariaKeyShortcut}
      disabled={disabled ?? false}
      onClick={onPrimaryClick}
      className={cn(
        'flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
        hasEscapeHatch && 'rounded-r-none',
      )}
    >
      <div className="flex w-full items-center justify-center gap-2">
        <AttachmentIcon />
      </div>
    </button>
  );

  if (!hasEscapeHatch) {
    return (
      <TooltipAnchor
        render={primaryButton}
        id="attach-file-button"
        description={tooltip}
        disabled={disabled ?? false}
      />
    );
  }

  const chevronTrigger = (
    <Ariakit.MenuButton
      disabled={disabled ?? false}
      id="attach-file-menu-button"
      aria-label="More upload options"
      className={cn(
        'flex h-9 w-5 items-center justify-center rounded-r-full border-l border-border-light hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
        isPopoverActive && 'bg-surface-hover',
      )}
    >
      <ChevronDown className="icon-sm text-text-secondary" aria-hidden="true" />
    </Ariakit.MenuButton>
  );

  return (
    <div className="flex items-center">
      <TooltipAnchor
        render={primaryButton}
        id="attach-file-button"
        description={tooltip}
        disabled={disabled ?? false}
      />
      <DropdownPopup
        menuId="attach-file-menu"
        className="overflow-visible"
        isOpen={isPopoverActive}
        setIsOpen={setIsPopoverActive}
        // Non-modal: a modal menu focus-traps and swallows the first click on the
        // adjacent paperclip button, so it takes two clicks to fire the primary upload.
        modal={false}
        unmountOnHide={true}
        trigger={chevronTrigger}
        items={overrideItems}
        iconClassName="mr-0"
      />
    </div>
  );
};

export default AttachFileButton;
