import { TooltipAnchor, NewChatIcon, Button } from '@librechat/client';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import useNewChat from '~/hooks/Chat/useNewChat';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Entry point for starting a new conversation. Renders as an anchor so
 * modified clicks still open `/c/new` in a new tab; `useNewChat` claims only
 * plain left clicks. `composer` draws it like the message box's paperclip.
 */
export default function NewChat({
  className,
  placement = 'header',
}: {
  className?: string;
  placement?: 'header' | 'composer';
}) {
  const localize = useLocalize();
  const { handleNewChatClick } = useNewChat();
  const tooltipDescription = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');

  if (placement === 'composer') {
    return (
      <TooltipAnchor
        description={tooltipDescription}
        render={
          <a
            href="/c/new"
            data-testid="composer-new-chat-button"
            aria-label={localize('com_ui_new_chat')}
            aria-keyshortcuts={ariaKey}
            onClick={handleNewChatClick}
            className={cn(
              'flex size-theme-control flex-shrink-0 items-center justify-center rounded-theme-control-round p-1 text-text-primary transition-colors duration-theme-fast hover:bg-surface-composer-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-opacity-50',
              className,
            )}
          >
            <NewChatIcon className="icon-md" aria-hidden="true" />
          </a>
        }
      />
    );
  }

  return (
    <TooltipAnchor
      description={tooltipDescription}
      render={
        <Button
          asChild
          size="icon"
          variant="outline"
          className={cn(
            'size-9 flex-shrink-0 rounded-xl bg-presentation hover:bg-surface-active-alt',
            className,
          )}
        >
          <a
            href="/c/new"
            data-testid="header-new-chat-button"
            aria-label={localize('com_ui_new_chat')}
            aria-keyshortcuts={ariaKey}
            onClick={handleNewChatClick}
          >
            <NewChatIcon className="icon-md" aria-hidden="true" />
          </a>
        </Button>
      }
    />
  );
}
