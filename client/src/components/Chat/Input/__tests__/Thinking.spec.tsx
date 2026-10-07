import { RecoilRoot, useRecoilValue } from 'recoil';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { ephemeralAgentByConvoId } from '~/store';
import Thinking from '../Thinking';

const mockStartupConfig: { thinkingEndpoints?: string[] } = { thinkingEndpoints: ['RNT'] };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

let lastAgent: unknown;
function AgentProbe({ conversationId }: { conversationId: string }) {
  lastAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId));
  return null;
}

const renderMenu = (endpoint: string | null = 'RNT') =>
  render(
    <RecoilRoot>
      <Thinking conversationId="convo-1" endpoint={endpoint} disabled={false} />
      <AgentProbe conversationId="convo-1" />
    </RecoilRoot>,
  );

describe('Thinking', () => {
  beforeEach(() => {
    mockStartupConfig.thinkingEndpoints = ['RNT'];
    lastAgent = undefined;
  });

  test('starts at auto and offers auto, on and off as radios', async () => {
    renderMenu();

    const trigger = screen.getByTestId('thinking-mode');
    expect(trigger).toHaveTextContent('com_ui_thinking_auto');
    expect(trigger).toHaveAttribute('aria-label', 'com_ui_thinking_mode: com_ui_thinking_auto');
    await userEvent.click(trigger);

    const menu = await screen.findByRole('menu', { name: 'com_ui_thinking_mode' });
    const options = within(menu).getAllByRole('menuitemradio');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    expect(options[1]).toHaveTextContent('com_ui_thinking_on');
    expect(options[2]).toHaveTextContent('com_ui_thinking_off');
  });

  test('stores on/off on the ephemeral agent and clears it for auto', async () => {
    renderMenu();

    await userEvent.click(screen.getByTestId('thinking-mode'));
    await userEvent.click(await screen.findByText('com_ui_thinking_off'));
    expect(lastAgent).toEqual({ thinking: 'off' });
    expect(screen.getByTestId('thinking-mode')).toHaveTextContent('com_ui_thinking_off');

    await userEvent.click(screen.getByTestId('thinking-mode'));
    await userEvent.click(await screen.findByText('com_ui_thinking_auto'));
    expect(lastAgent).toEqual({});
  });

  test('shows only on endpoints the classifier controls', () => {
    const { unmount } = renderMenu('openAI');
    expect(screen.queryByTestId('thinking-mode')).toBeNull();
    unmount();

    mockStartupConfig.thinkingEndpoints = undefined;
    renderMenu();
    expect(screen.queryByTestId('thinking-mode')).toBeNull();
  });
});
