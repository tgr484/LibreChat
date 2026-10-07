import { memo } from 'react';
import { useRecoilState } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { TooltipAnchor, composerControlClasses } from '@librechat/client';
import { Brain, BrainCircuit, Check, ChevronDown, Zap } from 'lucide-react';
import type { TThinkingMode } from 'librechat-data-provider';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import { ephemeralAgentByConvoId } from '~/store';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ThinkingChoice = 'auto' | TThinkingMode;

const CHOICES: ThinkingChoice[] = ['auto', 'on', 'off'];

const choiceOptions: Record<
  ThinkingChoice,
  { icon: LucideIcon; label: TranslationKeys; description: TranslationKeys }
> = {
  auto: {
    icon: BrainCircuit,
    label: 'com_ui_thinking_auto',
    description: 'com_ui_thinking_auto_description',
  },
  on: {
    icon: Brain,
    label: 'com_ui_thinking_on',
    description: 'com_ui_thinking_on_description',
  },
  off: {
    icon: Zap,
    label: 'com_ui_thinking_off',
    description: 'com_ui_thinking_off_description',
  },
};

/**
 * Whether the model reasons before answering, on endpoints the server's
 * classifier controls: «Авто» leaves it to the classifier, «Вкл»/«Выкл»
 * override it. The choice lives in the conversation's ephemeral agent and is
 * not persisted, so a new chat starts at «Авто» again.
 */
function Thinking({
  conversationId,
  endpoint,
  disabled,
}: {
  conversationId: string;
  endpoint?: string | null;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(
    ephemeralAgentByConvoId(conversationId),
  );
  const menuStore = Ariakit.useMenuStore({ focusLoop: true, placement: 'top-start' });
  const isOpen = menuStore.useState('open');

  if (endpoint == null || startupConfig?.thinkingEndpoints?.includes(endpoint) !== true) {
    return null;
  }

  const stored = ephemeralAgent?.thinking;
  const selected: ThinkingChoice = stored === 'on' || stored === 'off' ? stored : 'auto';

  const select = (choice: ThinkingChoice) => {
    setEphemeralAgent((prev) => {
      const { thinking: _previous, ...rest } = prev ?? {};
      return choice === 'auto' ? rest : { ...rest, thinking: choice };
    });
  };

  const SelectedIcon = choiceOptions[selected].icon;
  const title = localize('com_ui_thinking_mode');

  return (
    <Ariakit.MenuProvider store={menuStore}>
      <TooltipAnchor
        description={title}
        disabled={isOpen}
        render={
          <Ariakit.MenuButton
            disabled={disabled}
            data-testid="thinking-mode"
            aria-label={`${title}: ${localize(choiceOptions[selected].label)}`}
            className={cn(
              composerControlClasses(),
              'px-2.5 md:px-theme-normal',
              isOpen && 'bg-surface-hover',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          />
        }
      >
        <SelectedIcon className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="max-w-[12rem] truncate">{localize(choiceOptions[selected].label)}</span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-text-secondary transition-transform',
            isOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </TooltipAnchor>
      <Ariakit.Menu
        portal={true}
        gutter={8}
        unmountOnHide={true}
        className={cn(
          'z-50 flex min-w-[280px] max-w-[min(320px,calc(100vw-2rem))] flex-col rounded-xl',
          'border border-border-light bg-presentation p-1.5 shadow-lg',
          'origin-bottom opacity-0 transition-[opacity,transform] duration-200 ease-out',
          'data-[enter]:scale-100 data-[enter]:opacity-100',
          'scale-95 data-[leave]:scale-95 data-[leave]:opacity-0',
        )}
      >
        <Ariakit.MenuHeading
          render={<div />}
          className="px-2.5 py-1.5 text-xs font-medium text-text-secondary"
        >
          {title}
        </Ariakit.MenuHeading>
        {CHOICES.map((choice) => {
          const { icon: Icon, label, description } = choiceOptions[choice];
          const isSelected = choice === selected;
          return (
            <Ariakit.MenuItemRadio
              key={choice}
              name="thinkingMode"
              value={choice}
              checked={isSelected}
              hideOnClick={true}
              onChange={() => select(choice)}
              className={cn(
                'group flex w-full cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2',
                'outline-none transition-colors duration-theme-fast',
                'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
                isSelected && 'bg-surface-active-alt',
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1 text-left">
                <div className="text-sm font-medium text-text-primary">{localize(label)}</div>
                <p className="text-xs text-text-secondary">{localize(description)}</p>
              </div>
              {isSelected && (
                <Check className="mt-0.5 size-4 shrink-0 text-text-primary" aria-hidden="true" />
              )}
            </Ariakit.MenuItemRadio>
          );
        })}
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}

export default memo(Thinking);
