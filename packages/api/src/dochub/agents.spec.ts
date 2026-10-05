import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { PrincipalType, ResourceType } from 'librechat-data-provider';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { Response, NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import type { DochubAgentData } from './agents';
import type { ServerRequest } from '~/types';
import {
  grantsToOthers,
  prepareDochubAgent,
  flattenCollections,
  createDochubShareGate,
  resolveDochubAgentsConfig,
  listDochubCollectionsHandler,
  publishDochubCollectionHandler,
} from './agents';
import { resetDochubConfigCache } from './config';

const dir = mkdtempSync(join(tmpdir(), 'dochub-agents-'));
const keyPath = join(dir, 'key.pem');
writeFileSync(
  keyPath,
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
);

type Route = () => { status: number; body: unknown };

let server: Server;
let baseURL: string;
let routes: Record<string, Route> = {};
let requests: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      const key = `${req.method} ${req.url ?? ''}`;
      requests.push(key);
      const route = routes[key];
      const reply = route ? route() : { status: 404, body: { detail: 'Not Found' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/integration/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const COLLECTIONS = '/api/integration/v1/collections';

/** The current contract: every card says whether it is public and who the user is. */
const currentListing = {
  my: [
    {
      id: 7,
      name: 'Кадровые вопросы',
      description: null,
      document_count: 12,
      is_public: false,
      role: 'owner',
    },
    {
      id: 8,
      name: 'Регламенты',
      description: null,
      document_count: 3,
      is_public: true,
      role: 'owner',
    },
  ],
  shared_with_me: [],
  public: [
    {
      id: 19,
      name: 'Инструкции',
      description: null,
      document_count: 9,
      owner_username: 'petrov',
      is_public: true,
      role: 'viewer',
    },
  ],
};

beforeEach(() => {
  resetDochubConfigCache();
  requests = [];
  routes = {
    [`GET ${COLLECTIONS}`]: () => ({ status: 200, body: currentListing }),
  };
});

const dochubConfig = (agents?: Record<string, unknown>): Pick<AppConfig, 'dochub'> => ({
  dochub: {
    enabled: true,
    baseURL,
    keyId: 'test',
    privateKeyPath: keyPath,
    ...(agents ? { agents } : {}),
  },
});

const makeReq = (overrides: Partial<ServerRequest> = {}): ServerRequest =>
  ({
    user: { id: 'u1', provider: 'ldap', ldapId: 'ivanov' } as unknown as IUser,
    config: dochubConfig({ endpoint: 'RNT', model: 'qwen' }) as AppConfig,
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as ServerRequest;

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

describe('resolveDochubAgentsConfig', () => {
  it('is off until the operator names the endpoint and the model', () => {
    expect(resolveDochubAgentsConfig(dochubConfig())).toBeUndefined();
    expect(resolveDochubAgentsConfig(dochubConfig({ endpoint: 'RNT' }))).toBeUndefined();
  });

  it('defaults Office generation to on', () => {
    expect(resolveDochubAgentsConfig(dochubConfig({ endpoint: 'RNT', model: 'qwen' }))).toEqual({
      endpoint: 'RNT',
      model: 'qwen',
      office: true,
    });
  });

  it('is off when disabled or when DocHub itself is not configured', () => {
    expect(
      resolveDochubAgentsConfig(dochubConfig({ endpoint: 'RNT', model: 'qwen', enabled: false })),
    ).toBeUndefined();
    expect(
      resolveDochubAgentsConfig({ dochub: { enabled: false, agents: { endpoint: 'RNT' } } }),
    ).toBeUndefined();
  });
});

describe('flattenCollections', () => {
  it('passes the contract fields through', () => {
    const flat = flattenCollections(currentListing as never);
    expect(flat.map(({ id, is_public, role, section }) => [id, is_public, role, section])).toEqual([
      [7, false, 'owner', 'my'],
      [8, true, 'owner', 'my'],
      [19, true, 'viewer', 'public'],
    ]);
  });

  it('infers role and visibility from the section on an older DocHub', () => {
    const flat = flattenCollections({
      my: [{ id: 1, name: 'a', description: null, document_count: 1 }],
      shared_with_me: [
        { id: 2, name: 'b', description: null, document_count: 1, owner_username: 'x' },
      ],
      public: [{ id: 3, name: 'c', description: null, document_count: 1, owner_username: 'y' }],
    });
    expect(flat.map(({ is_public, role }) => [is_public, role])).toEqual([
      [null, 'owner'],
      [null, 'coauthor'],
      [true, 'viewer'],
    ]);
  });
});

describe('prepareDochubAgent', () => {
  it('leaves a regular agent untouched and never asks DocHub', async () => {
    const data = { name: 'x', tools: ['calculator'] };
    const result = await prepareDochubAgent({
      req: makeReq(),
      data,
      loadExisting: async () => undefined,
    });
    expect(result).toEqual({ ok: true, data });
    expect(requests).toEqual([]);
  });

  it('reads the stored pin only when the update touches tools or model', async () => {
    const loadExisting = jest.fn(async () => undefined);
    const rename: DochubAgentData & { name: string } = { name: 'only a rename' };
    await prepareDochubAgent({ req: makeReq(), data: rename, loadExisting });
    expect(loadExisting).not.toHaveBeenCalled();
  });

  it('fixes the shape of a new DocHub agent and takes the name from DocHub', async () => {
    const result = await prepareDochubAgent({
      req: makeReq(),
      data: {
        provider: 'openAI',
        model: 'gpt-4o',
        tools: ['calculator', 'create_document', 'dochub_survey'],
        dochub: { collection_id: 7, collection_name: 'подменённое имя' },
      },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        provider: 'RNT',
        model: 'qwen',
        tools: ['dochub_agent_list', 'dochub_agent_search', 'dochub_agent_read', 'create_document'],
        dochub: { collection_id: 7, collection_name: 'Кадровые вопросы' },
      },
    });
  });

  it('adds the Office tools by default and leaves them out when switched off', async () => {
    const pinOnly: DochubAgentData = { dochub: { collection_id: 8 } };
    const withOffice = await prepareDochubAgent({ req: makeReq(), data: pinOnly });
    expect(withOffice.ok && withOffice.data.tools).toEqual(
      expect.arrayContaining(['create_document', 'create_presentation', 'create_spreadsheet']),
    );

    const req = makeReq({
      config: dochubConfig({ endpoint: 'RNT', model: 'qwen', office: false }) as AppConfig,
    });
    const without = await prepareDochubAgent({ req, data: pinOnly });
    expect(without.ok && without.data.tools).toEqual([
      'dochub_agent_list',
      'dochub_agent_search',
      'dochub_agent_read',
    ]);
  });

  it('refuses a collection the saving user cannot see', async () => {
    const result = await prepareDochubAgent({
      req: makeReq(),
      data: { dochub: { collection_id: 999 } },
    });
    expect(result).toMatchObject({ ok: false, status: 404, code: 'dochub_collection_unavailable' });
  });

  it('keeps the shape of a stored DocHub agent on an update without a pin', async () => {
    const result = await prepareDochubAgent({
      req: makeReq(),
      data: { tools: ['calculator'] },
      loadExisting: async () => ({ collection_id: 7, collection_name: 'Кадровые вопросы' }),
    });
    expect(result).toEqual({
      ok: true,
      data: {
        tools: ['dochub_agent_list', 'dochub_agent_search', 'dochub_agent_read'],
        provider: 'RNT',
        model: 'qwen',
      },
    });
    expect(requests).toEqual([]);
  });

  it('keeps the stored collection on an update without asking DocHub', async () => {
    const stored = { collection_id: 7, collection_name: 'Кадровые вопросы' };
    const result = await prepareDochubAgent({
      req: makeReq(),
      data: { dochub: { collection_id: 7, collection_name: 'другое' } },
      loadExisting: async () => stored,
    });
    expect(result.ok && result.data.dochub).toEqual(stored);
    expect(requests).toEqual([]);
  });

  it('refuses to move an existing DocHub agent to another collection', async () => {
    const result = await prepareDochubAgent({
      req: makeReq(),
      data: { dochub: { collection_id: 8 } },
      loadExisting: async () => ({ collection_id: 7, collection_name: 'Кадровые вопросы' }),
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'dochub_collection_locked' });
    expect(requests).toEqual([]);
  });

  it('refuses users without an LDAP identity', async () => {
    const req = makeReq({ user: { id: 'u2', provider: 'local' } as unknown as IUser });
    const result = await prepareDochubAgent({ req, data: { dochub: { collection_id: 7 } } });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'dochub_not_ldap' });
  });

  it('refuses DocHub agents when the operator has not enabled them', async () => {
    const req = makeReq({ config: dochubConfig() as AppConfig });
    const result = await prepareDochubAgent({ req, data: { dochub: { collection_id: 7 } } });
    expect(result).toMatchObject({ ok: false, code: 'dochub_not_configured' });
  });
});

describe('listDochubCollectionsHandler', () => {
  it('answers with the flat list', async () => {
    const res = makeRes();
    await listDochubCollectionsHandler(makeReq(), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].collections).toHaveLength(3);
  });
});

describe('publishDochubCollectionHandler', () => {
  const publishReq = (dryRun: boolean) =>
    makeReq({
      params: { id: '7' },
      query: { dry_run: dryRun ? '1' : undefined },
    } as unknown as Partial<ServerRequest>) as Parameters<typeof publishDochubCollectionHandler>[0];

  it('reports counts of what the dry run would change', async () => {
    routes[`POST ${COLLECTIONS}/7/publish?dry_run=true`] = () => ({
      status: 200,
      body: { id: 7, is_public: false, made_public: [1, 2], removed_private: [3] },
    });
    const res = makeRes();
    await publishDochubCollectionHandler(publishReq(true), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      id: 7,
      is_public: false,
      made_public: 2,
      removed_private: 1,
    });
  });

  it('says so when DocHub has no publish route yet', async () => {
    const res = makeRes();
    await publishDochubCollectionHandler(publishReq(false), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json.mock.calls[0][0].error).toBe('dochub_publish_unsupported');
  });

  it('passes on that only a manager may publish', async () => {
    routes[`POST ${COLLECTIONS}/7/publish?dry_run=false`] = () => ({
      status: 403,
      body: { detail: 'not_manager' },
    });
    const res = makeRes();
    await publishDochubCollectionHandler(publishReq(false), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toBe('dochub_not_manager');
  });
});

describe('grantsToOthers', () => {
  it('counts public and third-party grants but never revocations', () => {
    expect(grantsToOthers({ public: true }, 'a')).toBe(true);
    expect(grantsToOthers({ updated: [{ type: PrincipalType.GROUP, id: 'g' }] }, 'a')).toBe(true);
    expect(grantsToOthers({ updated: [{ type: PrincipalType.USER, id: 'b' }] }, 'a')).toBe(true);
    expect(grantsToOthers({ updated: [{ type: PrincipalType.USER, id: 'a' }] }, 'a')).toBe(false);
    expect(grantsToOthers({ public: false, updated: [] }, 'a')).toBe(false);
  });
});

describe('createDochubShareGate', () => {
  const run = async (params: {
    agent: { author?: string; dochub?: { collection_id: number } } | null;
    body: Record<string, unknown>;
    resourceType?: string;
  }) => {
    const gate = createDochubShareGate({ getAgentByObjectId: async () => params.agent });
    const req = makeReq({
      params: { resourceType: params.resourceType ?? ResourceType.AGENT, resourceId: 'abc' },
      body: params.body,
    } as unknown as Partial<ServerRequest>);
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    await gate(req as Parameters<typeof gate>[0], res as unknown as Response, next);
    return { res, next };
  };

  it('stops sharing an agent whose collection is private', async () => {
    const { res, next } = await run({
      agent: { author: 'u1', dochub: { collection_id: 7 } },
      body: { public: true },
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'dochub_collection_private',
      collection_name: 'Кадровые вопросы',
      role: 'owner',
    });
  });

  it('gates remote-agent sharing the same way', async () => {
    const { res } = await run({
      agent: { author: 'u1', dochub: { collection_id: 7 } },
      body: { updated: [{ type: PrincipalType.USER, id: 'u9' }] },
      resourceType: ResourceType.REMOTE_AGENT,
    });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('lets a public collection through', async () => {
    const { next } = await run({
      agent: { author: 'u1', dochub: { collection_id: 8 } },
      body: { public: true },
    });
    expect(next).toHaveBeenCalled();
  });

  it('treats an unknown visibility as private', async () => {
    routes[`GET ${COLLECTIONS}`] = () => ({
      status: 200,
      body: {
        my: [{ id: 8, name: 'Регламенты', description: null, document_count: 3 }],
        shared_with_me: [],
        public: [],
      },
    });
    const { res } = await run({
      agent: { author: 'u1', dochub: { collection_id: 8 } },
      body: { public: true },
    });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('never stands in the way of revoking or of regular agents', async () => {
    const revoke = await run({
      agent: { author: 'u1', dochub: { collection_id: 7 } },
      body: { public: false, removed: [{ type: PrincipalType.USER, id: 'u9' }] },
    });
    expect(revoke.next).toHaveBeenCalled();

    const regular = await run({ agent: { author: 'u1' }, body: { public: true } });
    expect(regular.next).toHaveBeenCalled();

    const otherType = await run({
      agent: { author: 'u1', dochub: { collection_id: 7 } },
      body: { public: true },
      resourceType: ResourceType.PROMPTGROUP,
    });
    expect(otherType.next).toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
