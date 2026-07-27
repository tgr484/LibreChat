import { fireEvent, render, screen } from '@testing-library/react';
import { EToolResources } from 'librechat-data-provider';
import DragDropModal from '../DragDropModal';

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    OGDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? React.createElement('div', null, children) : null,
    OGDialogTemplate: ({ title, main }: { title: React.ReactNode; main: React.ReactNode }) =>
      React.createElement('div', null, title, main),
  };
});

jest.mock('~/hooks', () => ({
  useAttachFileOptions: jest.fn(),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useDragDropContext: () => ({
    conversationId: 'test-convo',
    agentId: undefined,
    endpoint: 'openAI',
    endpointType: 'openAI',
    useResponsesApi: false,
  }),
}));

const mockUseAttachFileOptions = jest.requireMock('~/hooks').useAttachFileOptions;

function setupMocks({
  resolveDefault = jest.fn(() => undefined),
  overrideOptions = [] as Array<{
    key: string;
    label: string;
    icon: React.ReactNode;
    toolResource?: EToolResources;
  }>,
  showEscapeHatch = true,
} = {}) {
  mockUseAttachFileOptions.mockReturnValue({ resolveDefault, overrideOptions, showEscapeHatch });
  return { resolveDefault };
}

const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });

describe('DragDropModal', () => {
  beforeEach(jest.clearAllMocks);

  it('renders nothing when not visible', () => {
    setupMocks();
    const { container } = render(
      <DragDropModal files={[file]} isVisible={false} setShowModal={jest.fn()} onOptionSelect={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the recommended native upload option when the default resource is undefined', () => {
    setupMocks({
      resolveDefault: jest.fn(() => undefined),
      overrideOptions: [
        { key: 'provider', label: 'Upload to Provider', icon: null },
        { key: 'context', label: 'Upload as Text', icon: null, toolResource: EToolResources.context },
      ],
    });
    render(
      <DragDropModal files={[file]} isVisible={true} setShowModal={jest.fn()} onOptionSelect={jest.fn()} />,
    );
    expect(screen.getByText('Upload to Provider')).toBeInTheDocument();
    expect(screen.getByText('com_ui_recommended')).toBeInTheDocument();
  });

  it('selecting the recommended option calls onOptionSelect with the resolved default', () => {
    const onOptionSelect = jest.fn();
    setupMocks({
      resolveDefault: jest.fn(() => EToolResources.context),
      overrideOptions: [
        { key: 'provider', label: 'Upload to Provider', icon: null },
        { key: 'context', label: 'Upload as Text', icon: null, toolResource: EToolResources.context },
      ],
    });
    render(
      <DragDropModal
        files={[file]}
        isVisible={true}
        setShowModal={jest.fn()}
        onOptionSelect={onOptionSelect}
      />,
    );
    fireEvent.click(screen.getByText('Upload as Text'));
    expect(onOptionSelect).toHaveBeenCalledWith(EToolResources.context);
  });

  it('hides the "more options" disclosure when showEscapeHatch is false', () => {
    setupMocks({
      showEscapeHatch: false,
      overrideOptions: [
        { key: 'provider', label: 'Upload to Provider', icon: null },
        {
          key: 'file_search',
          label: 'Upload for File Search',
          icon: null,
          toolResource: EToolResources.file_search,
        },
      ],
    });
    render(
      <DragDropModal files={[file]} isVisible={true} setShowModal={jest.fn()} onOptionSelect={jest.fn()} />,
    );
    expect(screen.queryByText('com_ui_more_options')).not.toBeInTheDocument();
    expect(screen.queryByText('Upload for File Search')).not.toBeInTheDocument();
  });

  it('reveals remaining options behind "more options" and selecting one calls onOptionSelect', () => {
    const onOptionSelect = jest.fn();
    setupMocks({
      resolveDefault: jest.fn(() => undefined),
      overrideOptions: [
        { key: 'provider', label: 'Upload to Provider', icon: null },
        {
          key: 'file_search',
          label: 'Upload for File Search',
          icon: null,
          toolResource: EToolResources.file_search,
        },
      ],
    });
    render(
      <DragDropModal
        files={[file]}
        isVisible={true}
        setShowModal={jest.fn()}
        onOptionSelect={onOptionSelect}
      />,
    );

    expect(screen.queryByText('Upload for File Search')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('com_ui_more_options'));
    fireEvent.click(screen.getByText('Upload for File Search'));
    expect(onOptionSelect).toHaveBeenCalledWith(EToolResources.file_search);
  });
});
