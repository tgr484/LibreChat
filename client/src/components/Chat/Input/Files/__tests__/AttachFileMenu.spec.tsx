import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EToolResources } from 'librechat-data-provider';
import AttachFileMenu from '../AttachFileMenu';

jest.mock('~/hooks', () => ({
  useAttachFileOptions: jest.fn(),
  useFileHandlingNoChatContext: jest.fn(),
  useLocalize: jest.fn(),
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  __esModule: true,
  default: jest.fn(),
  useSharePointFileHandlingNoChatContext: jest.fn(),
}));

jest.mock('~/components/SharePoint', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    SharePointPickerDialog: (props: { isOpen: boolean }) =>
      props.isOpen ? R.createElement('div', { 'data-testid': 'sharepoint-dialog-open' }) : null,
  };
});

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    FileUpload: R.forwardRef((props, ref) =>
      R.createElement(
        'div',
        { 'data-testid': 'file-upload' },
        props.children,
        R.createElement('input', {
          ref,
          multiple: true,
          type: 'file',
          'data-testid': 'file-input',
          onChange: props.handleFileChange,
        }),
      ),
    ),
    TooltipAnchor: (props) => props.render,
    DropdownPopup: (props) =>
      R.createElement(
        'div',
        null,
        R.createElement('div', { onClick: () => props.setIsOpen(!props.isOpen) }, props.trigger),
        props.isOpen &&
          R.createElement(
            'div',
            { 'data-testid': 'dropdown-menu' },
            props.items.map((item, idx) =>
              R.createElement(
                'button',
                { key: idx, onClick: item.onClick, 'data-testid': `menu-item-${idx}` },
                item.label,
              ),
            ),
          ),
      ),
    AttachmentIcon: () => R.createElement('span', { 'data-testid': 'attachment-icon' }),
    SharePointIcon: () => R.createElement('span', { 'data-testid': 'sharepoint-icon' }),
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('@ariakit/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    MenuButton: (props) => R.createElement('button', props, props.children),
  };
});

const mockUseAttachFileOptions = jest.requireMock('~/hooks').useAttachFileOptions;
const mockUseFileHandlingNoChatContext = jest.requireMock('~/hooks').useFileHandlingNoChatContext;
const mockUseLocalize = jest.requireMock('~/hooks').useLocalize;
const mockUseSharePointFileHandlingNoChatContext = jest.requireMock(
  '~/hooks/Files/useSharePointFileHandling',
).useSharePointFileHandlingNoChatContext;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const translations: Record<string, string> = {
  com_sidepanel_attach_files: 'Attach Files',
};

function setupMocks({
  resolveDefault = jest.fn(() => undefined),
  overrideOptions = [] as Array<{
    key: string;
    label: string;
    icon: React.ReactNode;
    toolResource?: EToolResources;
    fileType?: string;
  }>,
  showEscapeHatch = true,
  handleFileChange = jest.fn(),
  handleSharePointFiles = jest.fn(),
} = {}) {
  mockUseLocalize.mockReturnValue((key: string) => translations[key] || key);
  mockUseFileHandlingNoChatContext.mockReturnValue({ handleFileChange });
  mockUseSharePointFileHandlingNoChatContext.mockReturnValue({
    handleSharePointFiles,
    isProcessing: false,
    downloadProgress: 0,
    error: null,
  });
  mockUseAttachFileOptions.mockReturnValue({
    resolveDefault,
    overrideOptions,
    showEscapeHatch,
  });
  return { resolveDefault, handleFileChange, handleSharePointFiles };
}

function renderMenu(props: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AttachFileMenu
          conversationId="test-convo"
          files={new Map()}
          setFiles={() => {}}
          setFilesLoading={() => {}}
          conversation={null}
          {...props}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

function selectFile(input: HTMLElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  fireEvent.change(input);
}

describe('AttachFileMenu', () => {
  beforeEach(jest.clearAllMocks);

  it('renders the primary attach button', () => {
    setupMocks();
    renderMenu();
    expect(screen.getByRole('button', { name: 'Attach File Options' })).toBeInTheDocument();
  });

  it('is disabled when disabled prop is true', () => {
    setupMocks();
    renderMenu({ disabled: true });
    expect(screen.getByRole('button', { name: 'Attach File Options' })).toBeDisabled();
  });

  it('clicking the primary button opens the file picker without a menu and uses the smart default', () => {
    const resolveDefault = jest.fn(() => EToolResources.context);
    const { handleFileChange } = setupMocks({ resolveDefault, overrideOptions: [] });
    renderMenu();

    expect(screen.queryByTestId('dropdown-menu')).not.toBeInTheDocument();

    const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
    selectFile(screen.getByTestId('file-input'), file);

    expect(resolveDefault).toHaveBeenCalledWith([file]);
    expect(handleFileChange).toHaveBeenCalledWith(expect.any(Object), EToolResources.context);
  });

  it('hides the chevron escape hatch when showEscapeHatch is false', () => {
    setupMocks({
      showEscapeHatch: false,
      overrideOptions: [{ key: 'provider', label: 'Force Provider', icon: null }],
    });
    renderMenu();
    expect(screen.queryByLabelText('More upload options')).not.toBeInTheDocument();
  });

  it('shows escape-hatch override items and uses the explicit tool_resource, bypassing the smart default', () => {
    const resolveDefault = jest.fn(() => undefined);
    const { handleFileChange } = setupMocks({
      resolveDefault,
      overrideOptions: [
        { key: 'file_search', label: 'Upload for File Search', icon: null, toolResource: EToolResources.file_search },
      ],
    });
    renderMenu();

    fireEvent.click(screen.getByLabelText('More upload options'));
    fireEvent.click(screen.getByText('Upload for File Search'));

    const file = new File(['data'], 'sheet.xlsx', { type: 'application/vnd.ms-excel' });
    selectFile(screen.getByTestId('file-input'), file);

    expect(resolveDefault).not.toHaveBeenCalled();
    expect(handleFileChange).toHaveBeenCalledWith(expect.any(Object), EToolResources.file_search);
  });

  it('opens the SharePoint dialog from the escape hatch instead of the native file picker', () => {
    setupMocks({
      overrideOptions: [{ key: 'sharepoint', label: 'Upload via SharePoint', icon: null }],
    });
    renderMenu();

    fireEvent.click(screen.getByLabelText('More upload options'));
    fireEvent.click(screen.getByText('Upload via SharePoint'));

    expect(screen.getByTestId('sharepoint-dialog-open')).toBeInTheDocument();
  });
});
