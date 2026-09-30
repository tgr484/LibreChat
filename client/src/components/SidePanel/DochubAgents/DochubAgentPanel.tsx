import { useEffect, useMemo, useState } from 'react';
import { Plus, MessageSquare } from 'lucide-react';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { Input, Label, Button, Spinner, Checkbox, useToastContext } from '@librechat/client';
import type {
  Agent,
  AgentCreateParams,
  TDochubCollection,
  AgentModelParameters,
} from 'librechat-data-provider';
import {
  useGetStartupConfig,
  useDochubAgentsQuery,
  useCreateAgentMutation,
  useUpdateAgentMutation,
  useDochubCollectionsQuery,
  useGetExpandedAgentByIdQuery,
} from '~/data-provider';
import { useLocalize, useSelectAgent } from '~/hooks';
import CollectionSelect from './CollectionSelect';
import ShareDochubAgent from './ShareDochubAgent';
import { dochubErrorKey } from './errors';

/** Tools a DocHub agent is saved with; the server enforces the same list. */
const DOCHUB_AGENT_TOOLS = ['dochub_agent_list', 'dochub_agent_search', 'dochub_agent_read'];
const OFFICE_TOOLS = ['create_document', 'create_presentation', 'create_spreadsheet'];
/** The operator's model runs with its own defaults; the server drops the nulls. */
const DEFAULT_MODEL_PARAMETERS: AgentModelParameters = {
  temperature: null,
  maxContextTokens: null,
  max_context_tokens: null,
  max_output_tokens: null,
  top_p: null,
  frequency_penalty: null,
  presence_penalty: null,
};

type DochubAgentDraft = {
  name: string;
  description: string;
  instructions: string;
  collection: Pick<TDochubCollection, 'id' | 'name'> | null;
  office: boolean;
};

const labelClass = 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary';

/**
 * «Агенты DocHub»: a trimmed agent builder. The user picks a collection, names
 * the agent and optionally edits its instructions; the model and the tools are
 * fixed by the server.
 */
export default function DochubAgentPanel() {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { onSelect: onSelectAgent } = useSelectAgent();
  const { data: startupConfig } = useGetStartupConfig();
  const settings = startupConfig?.dochubAgents;

  const collectionsQuery = useDochubCollectionsQuery({ enabled: !!settings });
  const agentsQuery = useDochubAgentsQuery({ enabled: !!settings });
  const collections = useMemo(
    () => collectionsQuery.data?.collections ?? [],
    [collectionsQuery.data],
  );

  const [agentId, setAgentId] = useState<string>('');
  const expandedQuery = useGetExpandedAgentByIdQuery(agentId, { enabled: !!agentId });

  const emptyDraft = (): DochubAgentDraft => ({
    name: '',
    description: '',
    instructions: '',
    collection: null,
    office: settings?.office ?? true,
  });
  const [draft, setDraft] = useState<DochubAgentDraft>(emptyDraft);

  const templateFor = (collection: DochubAgentDraft['collection']) =>
    collection ? localize('com_ui_dochub_default_instructions', { name: collection.name }) : '';

  useEffect(() => {
    const agent = expandedQuery.data;
    if (!agentId || !agent || agent.id !== agentId) {
      return;
    }
    const pin = agent.dochub;
    setDraft({
      name: agent.name ?? '',
      description: agent.description ?? '',
      instructions: agent.instructions ?? '',
      collection: pin
        ? { id: pin.collection_id, name: pin.collection_name ?? String(pin.collection_id) }
        : null,
      office: OFFICE_TOOLS.some((tool) => agent.tools?.includes(tool)),
    });
  }, [agentId, expandedQuery.data]);

  const onSaved = (agent: Agent) => {
    queryClient.invalidateQueries([QueryKeys.dochubAgents]);
    setAgentId(agent.id);
    showToast({
      message: localize('com_assistants_update_success_name', { name: agent.name ?? '' }),
      status: 'success',
    });
  };
  const onFailed = (error: unknown) =>
    showToast({ message: localize(dochubErrorKey(error)), status: 'error' });

  const create = useCreateAgentMutation({ onSuccess: onSaved, onError: onFailed });
  const update = useUpdateAgentMutation({ onSuccess: onSaved, onError: onFailed });
  const isSaving = create.isLoading || update.isLoading;

  if (!settings) {
    return (
      <p className="p-3 text-sm text-text-secondary">
        {localize('com_ui_dochub_error_not_configured')}
      </p>
    );
  }

  const selectCollection = (collection: TDochubCollection) =>
    setDraft((current) => ({
      ...current,
      collection,
      name: current.name || collection.name,
      instructions:
        !current.instructions || current.instructions === templateFor(current.collection)
          ? templateFor(collection)
          : current.instructions,
    }));

  const startNew = () => {
    setAgentId('');
    setDraft(emptyDraft());
  };

  const save = () => {
    if (!draft.collection) {
      return showToast({ message: localize('com_ui_dochub_select_collection'), status: 'error' });
    }
    if (!draft.name.trim()) {
      return showToast({ message: localize('com_agents_missing_name'), status: 'error' });
    }
    const fields = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      instructions: draft.instructions,
      tools: [...DOCHUB_AGENT_TOOLS, ...(draft.office ? OFFICE_TOOLS : [])],
      dochub: { collection_id: draft.collection.id },
    };
    if (agentId) {
      update.mutate({ agent_id: agentId, data: fields });
      return;
    }
    const params: AgentCreateParams = {
      ...fields,
      provider: settings.endpoint,
      model: settings.model,
      model_parameters: DEFAULT_MODEL_PARAMETERS,
    };
    create.mutate(params);
  };

  const agents = agentsQuery.data?.data ?? [];
  const current = agents.find((agent) => agent.id === agentId);
  const collectionsError =
    collectionsQuery.error != null ? localize(dochubErrorKey(collectionsQuery.error)) : null;

  return (
    <div className="flex flex-1 flex-col gap-3 px-3 pb-3 pt-2">
      <div className="flex flex-col">
        <Label className={labelClass} htmlFor="dochub-agent-select">
          {localize('com_ui_dochub_agents')}
        </Label>
        <select
          id="dochub-agent-select"
          value={agentId}
          onChange={(event) => (event.target.value ? setAgentId(event.target.value) : startNew())}
          className="h-9 w-full rounded-lg border border-border-light bg-surface-secondary px-2 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
        >
          <option value="">{localize('com_ui_dochub_new_agent')}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>

      {agentId && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={startNew}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            {localize('com_ui_dochub_new_agent')}
          </Button>
          <Button type="button" variant="submit" onClick={() => onSelectAgent(agentId)}>
            <MessageSquare className="mr-1 h-4 w-4" aria-hidden="true" />
            {localize('com_ui_dochub_open_chat')}
          </Button>
        </div>
      )}

      {agentId && expandedQuery.isLoading ? (
        <span role="status" aria-label={localize('com_ui_loading')}>
          <Spinner className="mx-auto h-5 w-5" />
        </span>
      ) : (
        <>
          <div className="flex flex-col">
            <Label className={labelClass} htmlFor="dochub-collection">
              {localize('com_ui_dochub_collection')}{' '}
              <span className="text-text-destructive">*</span>
            </Label>
            {agentId ? (
              <Input
                id="dochub-collection"
                value={draft.collection?.name ?? ''}
                disabled
                className="h-9"
                title={localize('com_ui_dochub_error_collection_locked')}
              />
            ) : (
              <>
                {collectionsQuery.isLoading && (
                  <span role="status" aria-label={localize('com_ui_loading')}>
                    <Spinner className="h-4 w-4" />
                  </span>
                )}
                {collectionsError && (
                  <p className="text-sm text-text-destructive" role="alert">
                    {collectionsError}
                  </p>
                )}
                {!collectionsQuery.isLoading && !collectionsError && collections.length === 0 && (
                  <p className="text-sm text-text-secondary">
                    {localize('com_ui_dochub_no_collections')}
                  </p>
                )}
                {collections.length > 0 && (
                  <CollectionSelect
                    id="dochub-collection"
                    value={draft.collection?.id ?? null}
                    collections={collections}
                    onChange={selectCollection}
                  />
                )}
              </>
            )}
          </div>

          <div className="flex flex-col">
            <Label className={labelClass} htmlFor="dochub-agent-name">
              {localize('com_ui_agent_name')} <span className="text-text-destructive">*</span>
            </Label>
            <Input
              id="dochub-agent-name"
              value={draft.name}
              maxLength={256}
              className="h-9"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>

          <div className="flex flex-col">
            <Label className={labelClass} htmlFor="dochub-agent-description">
              {localize('com_ui_description')}
            </Label>
            <Input
              id="dochub-agent-description"
              value={draft.description}
              maxLength={512}
              className="h-9"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </div>

          <div className="flex flex-col">
            <Label className={labelClass} htmlFor="dochub-agent-instructions">
              {localize('com_ui_instructions')}
            </Label>
            <textarea
              id="dochub-agent-instructions"
              value={draft.instructions}
              rows={6}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              className="w-full resize-y rounded-lg border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-text-primary">
            <Checkbox
              checked={draft.office}
              onCheckedChange={(checked) => setDraft({ ...draft, office: checked === true })}
              aria-label={localize('com_ui_dochub_office')}
            />
            {localize('com_ui_dochub_office')}
          </label>

          <p className="text-xs text-text-secondary">
            {localize('com_ui_dochub_model_note', { model: settings.model })}
          </p>

          <div className="flex items-center justify-end gap-2">
            {current && (
              <ShareDochubAgent
                agent={current}
                collection={collections.find(
                  (collection) => collection.id === current.dochub?.collection_id,
                )}
              />
            )}
            <Button type="button" variant="submit" disabled={isSaving} onClick={save}>
              {isSaving ? (
                <span role="status" aria-label={localize('com_ui_loading')}>
                  <Spinner className="h-4 w-4" />
                </span>
              ) : (
                localize(agentId ? 'com_ui_save' : 'com_ui_create')
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
