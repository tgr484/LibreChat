import { logger } from '@librechat/data-schemas';
import { PrincipalType, ResourceType } from 'librechat-data-provider';
import type {
  TDochubErrorCode,
  TDochubCollection,
  TDochubAgentsStartup,
  TDochubPublishResponse,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response, NextFunction } from 'express';
import type { DochubCollectionsResponse, DochubCollectionSummary } from './types';
import type { DochubSessionFailure, DochubSession } from './session';
import type { ServerRequest } from '~/types';
import { DOCHUB_AGENT_TOOL_NAMES } from '~/tools/toolkits/dochub';
import { OFFICE_TOOL_NAMES } from '~/tools/toolkits/office';
import { openDochubSession } from './session';
import { isDochubConfigured } from './config';
import { DochubError } from './errors';

/**
 * The operator's settings for DocHub agents, or `undefined` when they cannot be
 * created: the integration is off, the feature is off, or no model is set.
 */
export function resolveDochubAgentsConfig(
  appConfig: Pick<AppConfig, 'dochub'> | undefined,
): TDochubAgentsStartup | undefined {
  const agents = appConfig?.dochub?.agents;
  if (agents?.enabled === false || !isDochubConfigured(appConfig)) {
    return undefined;
  }
  const endpoint = agents?.endpoint?.trim();
  const model = agents?.model?.trim();
  if (!endpoint || !model) {
    return undefined;
  }
  return { endpoint, model, office: agents?.office !== false };
}

const SECTIONS: ReadonlyArray<[keyof DochubCollectionsResponse, TDochubCollection['role']]> = [
  ['my', 'owner'],
  ['shared_with_me', 'coauthor'],
  ['public', 'viewer'],
];

/**
 * One flat list for the picker. A DocHub that predates `is_public`/`role` still
 * works: the section implies the role, and only the `public` section is known
 * to be public — the user's own collections come back as unknown (`null`).
 */
export function flattenCollections(response: DochubCollectionsResponse): TDochubCollection[] {
  return SECTIONS.flatMap(([section, fallbackRole]) =>
    (response[section] ?? []).map((collection: DochubCollectionSummary) => ({
      id: collection.id,
      name: collection.name,
      description: collection.description,
      document_count: collection.document_count,
      ...(collection.owner_username != null ? { owner_username: collection.owner_username } : {}),
      is_public: collection.is_public ?? (section === 'public' ? true : null),
      role: collection.role ?? fallbackRole,
      section,
    })),
  );
}

type Failure = { ok: false; status: number; code: TDochubErrorCode; message: string };

const SESSION_FAILURES: Readonly<Record<DochubSessionFailure, Failure>> = {
  not_configured: {
    ok: false,
    status: 503,
    code: 'dochub_not_configured',
    message: 'DocHub integration is not configured',
  },
  not_ldap: {
    ok: false,
    status: 403,
    code: 'dochub_not_ldap',
    message: 'DocHub is available only to users signed in with LDAP',
  },
  no_identity: {
    ok: false,
    status: 403,
    code: 'dochub_no_identity',
    message: 'The account has no DocHub login',
  },
};

function failureFromError(error: unknown, context: string): Failure {
  if (error instanceof DochubError) {
    if (error.kind === 'collection_not_found' || error.kind === 'forbidden') {
      return {
        ok: false,
        status: 404,
        code: 'dochub_collection_unavailable',
        message: 'The collection is not available to this user',
      };
    }
    if (error.kind === 'not_manager') {
      return {
        ok: false,
        status: 403,
        code: 'dochub_not_manager',
        message: 'Only the owner or a coauthor can make the collection public',
      };
    }
    logger.warn(`[dochub] ${context} failed: ${error.message}`);
  } else {
    logger.error(`[dochub] ${context} failed`, error);
  }
  return {
    ok: false,
    status: 502,
    code: 'dochub_unavailable',
    message: 'DocHub is not available',
  };
}

/** Runs one DocHub interaction as the requesting user and always releases its budget. */
async function withSession<T>(
  req: ServerRequest,
  context: string,
  handler: (session: DochubSession) => Promise<T | Failure>,
): Promise<T | Failure> {
  const opened = openDochubSession({ req });
  if (!opened.ok) {
    return SESSION_FAILURES[opened.reason];
  }
  try {
    return await handler(opened.session);
  } catch (error) {
    return failureFromError(error, context);
  } finally {
    opened.session.budget.dispose();
  }
}

const isFailure = (value: unknown): value is Failure =>
  (value as Failure | undefined)?.ok === false;

async function findCollection(
  session: DochubSession,
  collectionId: number,
): Promise<TDochubCollection | Failure> {
  const collections = flattenCollections(await session.client.listCollections());
  const found = collections.find((collection) => collection.id === collectionId);
  return (
    found ?? {
      ok: false,
      status: 404,
      code: 'dochub_collection_unavailable',
      message: 'The collection is not available to this user',
    }
  );
}

const sendFailure = (res: Response, failure: Failure): Response =>
  res.status(failure.status).json({ error: failure.code, message: failure.message });

/** `GET /api/dochub/collections` — the picker of the «Агенты DocHub» builder. */
export async function listDochubCollectionsHandler(
  req: ServerRequest,
  res: Response,
): Promise<Response> {
  const result = await withSession(req, 'collections', async (session) =>
    flattenCollections(await session.client.listCollections()),
  );
  if (isFailure(result)) {
    return sendFailure(res, result);
  }
  return res.status(200).json({ collections: result });
}

/**
 * `POST /api/dochub/collections/:id/publish[?dry_run=1]` — the one write. The
 * client shows the dry run as a warning before it asks for the real call.
 */
export async function publishDochubCollectionHandler(
  req: ServerRequest & { params: { id?: string }; query: { dry_run?: string } },
  res: Response,
): Promise<Response> {
  const collectionId = Number(req.params.id);
  if (!Number.isInteger(collectionId) || collectionId <= 0) {
    return res.status(400).json({ error: 'dochub_collection_unavailable', message: 'Bad id' });
  }
  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';

  const result = await withSession(req, 'publish', async (session) => {
    try {
      return await session.client.publishCollection(collectionId, { dryRun });
    } catch (error) {
      /** The framework's own 404: this DocHub has no publish route yet. */
      if (error instanceof DochubError && error.kind === 'integration_off') {
        return {
          ok: false,
          status: 501,
          code: 'dochub_publish_unsupported',
          message: 'This DocHub cannot publish collections from LibreChat',
        } satisfies Failure;
      }
      throw error;
    }
  });
  if (isFailure(result)) {
    return sendFailure(res, result);
  }

  if (!dryRun) {
    logger.info(
      `[dochub] collection ${collectionId} made public by user ${req.user?.id}: ${result.made_public.length} documents published, ${result.removed_private.length} removed`,
    );
  }
  const response: TDochubPublishResponse = {
    id: result.id,
    is_public: result.is_public,
    made_public: result.made_public.length,
    removed_private: result.removed_private.length,
  };
  return res.status(200).json(response);
}

/** The fields of an agent create/update body this module reads and rewrites. */
export interface DochubAgentData {
  dochub?: { collection_id: number; collection_name?: string };
  tools?: string[];
  provider?: string;
  model?: string | null;
}

const DOCHUB_AGENT_TOOLS = new Set(DOCHUB_AGENT_TOOL_NAMES);
const ALLOWED_TOOLS = new Set([...DOCHUB_AGENT_TOOL_NAMES, ...OFFICE_TOOL_NAMES]);

/**
 * A DocHub agent is a fixed shape: its collection's pinned tools, optionally
 * the Office tools, and the operator's model. Whatever else the client sends
 * in those fields is replaced.
 */
function enforceShape<T extends DochubAgentData>(data: T, settings: TDochubAgentsStartup): T {
  const requested = data.tools ?? [...(settings.office ? OFFICE_TOOL_NAMES : [])];
  const extras = requested.filter(
    (name) => ALLOWED_TOOLS.has(name) && !DOCHUB_AGENT_TOOLS.has(name),
  );
  return {
    ...data,
    tools: [...DOCHUB_AGENT_TOOL_NAMES, ...new Set(extras)],
    provider: settings.endpoint,
    model: settings.model,
  };
}

/**
 * Validates and normalizes a DocHub agent before it is saved. The collection
 * must be one the saving user can see in DocHub; its name is taken from DocHub,
 * not from the client. Bodies of regular agents pass through untouched.
 *
 * The collection is fixed once the agent exists: the share gate checks the
 * collection when access is granted, so re-pinning a shared agent to another
 * (private) collection would slip past the consent it asks for.
 *
 * @param loadExisting Update only: the stored pin, read only when needed.
 */
export async function prepareDochubAgent<T extends DochubAgentData>(params: {
  req: ServerRequest;
  data: T;
  loadExisting?: () => Promise<DochubAgentData['dochub'] | undefined>;
}): Promise<{ ok: true; data: T } | Failure> {
  const { req, data } = params;
  const touchesShape = data.tools != null || data.provider != null || data.model != null;
  const existing = data.dochub != null || touchesShape ? await params.loadExisting?.() : undefined;
  if (data.dochub == null && existing == null) {
    return { ok: true, data };
  }
  if (
    existing != null &&
    data.dochub != null &&
    existing.collection_id !== data.dochub.collection_id
  ) {
    return {
      ok: false,
      status: 400,
      code: 'dochub_collection_locked',
      message: 'The collection of a DocHub agent cannot be changed',
    };
  }

  const settings = resolveDochubAgentsConfig(req.config);
  if (!settings) {
    return SESSION_FAILURES.not_configured;
  }
  if (data.dochub == null) {
    return { ok: true, data: enforceShape(data, settings) };
  }

  if (existing != null) {
    return { ok: true, data: { ...enforceShape(data, settings), dochub: existing } };
  }

  const pin = data.dochub;
  const result = await withSession(req, 'agent save', (session) =>
    findCollection(session, pin.collection_id),
  );
  if (isFailure(result)) {
    return result;
  }
  const shaped = enforceShape(data, settings);
  return {
    ok: true,
    data: { ...shaped, dochub: { collection_id: result.id, collection_name: result.name } },
  };
}

/** The part of a permissions update request the share gate reads. */
interface ShareRequestBody {
  updated?: Array<{ type?: string; id?: string | null }>;
  public?: boolean;
}

/**
 * Whether a permissions update gives the agent to anyone besides its author.
 * Revocations never count: taking access away must always work.
 */
export function grantsToOthers(body: ShareRequestBody | undefined, authorId: string): boolean {
  if (body?.public === true) {
    return true;
  }
  return (body?.updated ?? []).some(
    (principal) =>
      principal.type === PrincipalType.PUBLIC ||
      principal.type === PrincipalType.GROUP ||
      principal.type === PrincipalType.ROLE ||
      (principal.type === PrincipalType.USER && String(principal.id) !== authorId),
  );
}

const GATED_RESOURCES: ReadonlySet<string> = new Set([
  ResourceType.AGENT,
  ResourceType.REMOTE_AGENT,
]);

type PinnedAgent = { author?: unknown; dochub?: DochubAgentData['dochub'] } | null;

/**
 * Share gate for DocHub agents: an agent may reach other users only when its
 * collection is public, otherwise its recipients could not use it. DocHub still
 * enforces access for every chat, so this is about consent, not secrecy — the
 * author makes the collection public (with a warning) before sharing. One rule
 * for everyone, admins included, and for both agent and remote-agent sharing.
 */
export function createDochubShareGate(deps: {
  getAgentByObjectId: (resourceId: string) => Promise<PinnedAgent>;
}) {
  return async function checkDochubAgentShare(
    req: ServerRequest & {
      params: { resourceType?: string; resourceId?: string };
      body: ShareRequestBody;
    },
    res: Response,
    next: NextFunction,
  ): Promise<void | Response> {
    const { resourceType, resourceId } = req.params;
    if (!resourceType || !resourceId || !GATED_RESOURCES.has(resourceType)) {
      return next();
    }
    try {
      const agent = await deps.getAgentByObjectId(resourceId);
      const pin = agent?.dochub;
      if (!pin || !grantsToOthers(req.body, String(agent?.author ?? ''))) {
        return next();
      }

      const result = await withSession(req, 'share gate', (session) =>
        findCollection(session, pin.collection_id),
      );
      if (isFailure(result)) {
        return sendFailure(res, result);
      }
      if (result.is_public !== true) {
        return res.status(409).json({
          error: 'dochub_collection_private',
          message: 'Make the DocHub collection public before sharing this agent',
          collection_id: result.id,
          collection_name: result.name,
          role: result.role,
        });
      }
      return next();
    } catch (error) {
      logger.error('[dochub] share gate failed', error);
      return res.status(500).json({ error: 'dochub_unavailable', message: 'Share check failed' });
    }
  };
}
