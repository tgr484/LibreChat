import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import type { TDochubCollection } from 'librechat-data-provider';
import DochubAgentPanel from '../DochubAgentPanel';
import ShareDochubAgent from '../ShareDochubAgent';

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockPublish = jest.fn();
const mockShowToast = jest.fn();
const mockStartupConfig = jest.fn();
const mockCollectionsQuery = jest.fn();

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
  useDochubCollectionsQuery: () => mockCollectionsQuery(),
  useDochubAgentsQuery: () => ({ data: { data: [] } }),
  useGetExpandedAgentByIdQuery: () => ({ data: undefined, isLoading: false }),
  useCreateAgentMutation: () => ({ mutate: mockCreate, isLoading: false }),
  useUpdateAgentMutation: () => ({ mutate: mockUpdate, isLoading: false }),
  usePublishDochubCollectionMutation: () => ({ mutate: mockPublish }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
  useSelectAgent: () => ({ onSelect: jest.fn() }),
  useAuthContext: () => ({ user: { id: 'u1', role: 'USER' } }),
  useHasAccess: () => true,
  useResourcePermissions: () => ({ hasPermission: () => true, isLoading: false }),
}));

jest.mock('~/components/Sharing', () => ({
  GenericGrantAccessDialog: () => <button type="button" data-testid="share-dialog" />,
}));

const collection = (overrides: Partial<TDochubCollection> = {}): TDochubCollection => ({
  id: 7,
  name: 'Кадровые вопросы',
  description: null,
  document_count: 12,
  is_public: false,
  role: 'owner',
  section: 'my',
  ...overrides,
});

const settings = { endpoint: 'RNT', model: 'qwen', office: true };

beforeEach(() => {
  jest.clearAllMocks();
  mockStartupConfig.mockReturnValue({ dochubAgents: settings });
  mockCollectionsQuery.mockReturnValue({
    data: { collections: [collection()] },
    isLoading: false,
    error: null,
  });
});

describe('DochubAgentPanel', () => {
  it('explains when DocHub agents are not configured', () => {
    mockStartupConfig.mockReturnValue({});
    render(<DochubAgentPanel />);
    expect(screen.getByText('com_ui_dochub_error_not_configured')).toBeInTheDocument();
  });

  it('shows a loading state while collections load', () => {
    mockCollectionsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<DochubAgentPanel />);
    expect(screen.getByLabelText('com_ui_loading')).toBeInTheDocument();
  });

  it('shows why collections could not be loaded', () => {
    mockCollectionsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { response: { data: { error: 'dochub_not_ldap' } } },
    });
    render(<DochubAgentPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_dochub_error_not_ldap');
  });

  it('says so when the user has no collections', () => {
    mockCollectionsQuery.mockReturnValue({
      data: { collections: [] },
      isLoading: false,
      error: null,
    });
    render(<DochubAgentPanel />);
    expect(screen.getByText('com_ui_dochub_no_collections')).toBeInTheDocument();
  });

  it('creates a pinned agent with the fixed model and tools', () => {
    render(<DochubAgentPanel />);
    fireEvent.change(screen.getByLabelText(/com_ui_dochub_collection/), {
      target: { value: '7' },
    });

    expect(screen.getByLabelText(/com_ui_agent_name/)).toHaveValue('Кадровые вопросы');
    expect(screen.getByLabelText('com_ui_instructions')).toHaveValue(
      'com_ui_dochub_default_instructions {"name":"Кадровые вопросы"}',
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create' }));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Кадровые вопросы',
        provider: 'RNT',
        model: 'qwen',
        dochub: { collection_id: 7 },
        tools: [
          'dochub_agent_list',
          'dochub_agent_search',
          'dochub_agent_read',
          'create_document',
          'create_presentation',
          'create_spreadsheet',
        ],
      }),
    );
  });

  it('leaves the Office tools out when unchecked', () => {
    render(<DochubAgentPanel />);
    fireEvent.change(screen.getByLabelText(/com_ui_dochub_collection/), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'com_ui_dochub_office' }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create' }));
    expect(mockCreate.mock.calls[0][0].tools).toEqual([
      'dochub_agent_list',
      'dochub_agent_search',
      'dochub_agent_read',
    ]);
  });

  it('refuses to save without a collection', () => {
    render(<DochubAgentPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create' }));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_dochub_select_collection', status: 'error' }),
    );
  });
});

describe('ShareDochubAgent', () => {
  const agent = { _id: 'db1', id: 'agent_1', name: 'HR', author: 'u1' };

  it('opens the regular share dialog for a public collection', () => {
    render(<ShareDochubAgent agent={agent} collection={collection({ is_public: true })} />);
    expect(screen.getByTestId('share-dialog')).toBeInTheDocument();
  });

  it('warns with what publishing changes before a private collection is shared', async () => {
    mockPublish.mockImplementation((params, options) => {
      if (params.dryRun) {
        options.onSuccess({ id: 7, is_public: false, made_public: 3, removed_private: 1 });
      }
    });
    render(<ShareDochubAgent agent={agent} collection={collection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_share' }));

    await waitFor(() =>
      expect(screen.getByText(/com_ui_dochub_share_made_public/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/com_ui_dochub_share_removed_private/)).toBeInTheDocument();
    expect(mockPublish).toHaveBeenCalledWith({ collectionId: 7, dryRun: true }, expect.any(Object));

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dochub_share_confirm' }));
    expect(mockPublish).toHaveBeenLastCalledWith({ collectionId: 7 }, expect.any(Object));
  });

  it('explains that only a manager can publish', () => {
    render(<ShareDochubAgent agent={agent} collection={collection({ role: 'viewer' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_share' }));
    expect(screen.getByText(/com_ui_dochub_share_not_manager/)).toBeInTheDocument();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
