import { render, screen, fireEvent } from '@testing-library/react';
import NewChat from '../NewChat';

const mockHandleNewChatClick = jest.fn();

jest.mock('~/hooks/Chat/useNewChat', () => ({
  __esModule: true,
  default: () => ({ handleNewChatClick: mockHandleNewChatClick }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutHint: (_id: string, label: string) => label,
  useShortcutAriaKey: () => 'Control+Shift+O',
}));

describe('NewChat', () => {
  beforeEach(() => mockHandleNewChatClick.mockClear());

  test('renders the composer variant as a paperclip-style link to a new chat', () => {
    render(<NewChat placement="composer" />);

    const link = screen.getByTestId('composer-new-chat-button');
    expect(link).toHaveAttribute('href', '/c/new');
    expect(link).toHaveAttribute('aria-label', 'com_ui_new_chat');
    expect(link).toHaveClass('size-theme-control', 'rounded-theme-control-round');
    expect(screen.queryByTestId('header-new-chat-button')).toBeNull();

    fireEvent.click(link);
    expect(mockHandleNewChatClick).toHaveBeenCalledTimes(1);
  });

  test('keeps the header variant by default', () => {
    render(<NewChat />);
    expect(screen.getByTestId('header-new-chat-button')).toHaveAttribute('href', '/c/new');
  });
});
