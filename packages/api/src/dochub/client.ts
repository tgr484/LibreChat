import axios from 'axios';
import { logger } from '@librechat/data-schemas';

import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import type { KeyObject } from 'node:crypto';
import type {
  DochubCollectionPage,
  DochubCollectionsResponse,
  DochubContent,
  DochubOutline,
  DochubRuntimeConfig,
  DochubSearchResponse,
  DochubSummaryResponse,
} from './types';
import type { RunBudget } from './budget';
import { DochubError, errorFromResponse, mapDochubError } from './errors';
import { signDochubToken } from './token';
import { stoppedError } from './budget';

export interface DochubClient {
  listCollections(): Promise<DochubCollectionsResponse>;
  getCollectionPage(
    collectionId: number,
    options?: { limit?: number; cursor?: string },
  ): Promise<DochubCollectionPage>;
  getSummary(collectionId: number, documentId: number): Promise<DochubSummaryResponse>;
  search(collectionId: number, query: string, topK: number): Promise<DochubSearchResponse>;
  getOutline(documentId: number): Promise<DochubOutline>;
  getContent(
    documentId: number,
    selection: { chapter: number } | { pageFrom: number; pageTo?: number },
    version?: string,
  ): Promise<DochubContent>;
}

export interface DochubClientParams {
  config: DochubRuntimeConfig;
  key: KeyObject;
  subject: { sub: string; lcUid?: string };
  budget: RunBudget;
  /** Test seam: the retry backoff must not make the suite sleep for real. */
  wait?: (ms: number) => Promise<void>;
  http?: AxiosInstance;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** Backoff for the failures DocHub tells clients to retry with a growing pause. */
const SERVER_DELAYS_MS = [2000, 5000] as const;

function detailOf(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return data.slice(0, 200);
  }
  const detail = (data as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === 'string') {
    return detail;
  }
  return detail == null ? undefined : JSON.stringify(detail).slice(0, 200);
}

function retryAfterMs(headers: unknown, fallback: number): number {
  const raw = (headers as Record<string, string> | undefined)?.['retry-after'];
  const seconds = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallback;
}

export function createDochubClient(params: DochubClientParams): DochubClient {
  const { config, key, subject, budget } = params;
  const wait = params.wait ?? sleep;
  const http =
    params.http ??
    axios.create({
      baseURL: config.baseURL,
      timeout: config.requestTimeoutMs,
      /** Statuses are mapped by `errors.ts`, so axios must not throw on them. */
      validateStatus: () => true,
    });

  /**
   * A second `401` means the key, the `kid` or the clock is wrong — a
   * configuration fault that every further call in this tool invocation would
   * hit as well, so the rest fail fast instead of hammering DocHub.
   */
  let authBroken = false;

  async function request<TResponse>(options: {
    route: string;
    url: string;
    method: 'get' | 'post';
    params?: Record<string, string | number>;
    data?: unknown;
    /** Search holds DocHub's ask slot, shared with its own UI chat. */
    slotAware?: boolean;
  }): Promise<TResponse> {
    if (authBroken) {
      throw new DochubError({
        kind: 'auth',
        message: 'DocHub authentication is broken for this run',
        retryable: false,
      });
    }

    let authAttempts = 0;
    let slotAttempts = 0;
    let serverAttempts = 0;

    for (;;) {
      budget.chargeHttp();
      const { token, jti } = signDochubToken({
        config,
        key,
        sub: subject.sub,
        lcUid: subject.lcUid,
      });
      const startedAt = Date.now();
      const requestConfig: AxiosRequestConfig = {
        url: options.url,
        method: options.method,
        params: options.params,
        data: options.data,
        signal: budget.signal,
        headers: { Authorization: `Bearer ${token}` },
      };

      let status: number;
      let payload: unknown;
      let headers: unknown;
      try {
        const response = await http.request(requestConfig);
        status = response.status;
        payload = response.data;
        headers = response.headers;
      } catch (error) {
        const transport = mapDochubError(error, options.route);
        const mapped =
          transport.kind === 'aborted' ? stoppedError(budget, options.route) : transport;
        logger.warn(
          `[dochub] sub=${subject.sub} route=${options.route} transport=${mapped.kind} jti=${jti.slice(0, 8)} ms=${Date.now() - startedAt}`,
        );
        if (
          mapped.kind === 'aborted' ||
          mapped.kind === 'budget' ||
          serverAttempts >= SERVER_DELAYS_MS.length
        ) {
          throw mapped;
        }
        await wait(SERVER_DELAYS_MS[serverAttempts]);
        serverAttempts += 1;
        continue;
      }

      const detail = status >= 400 ? detailOf(payload) : undefined;
      /** Never the token, the document text or the user's question. */
      logger.info(
        `[dochub] sub=${subject.sub} lc_uid=${subject.lcUid ?? '-'} route=${options.route} status=${status} jti=${jti.slice(0, 8)} ms=${Date.now() - startedAt}`,
      );

      if (status >= 200 && status < 300) {
        return payload as TResponse;
      }

      const error = errorFromResponse({ status, detail, route: options.route });

      if (error.kind === 'auth' && authAttempts < 1) {
        authAttempts += 1;
        /** A fresh token carries a fresh `jti`; a repeat would be a 401 by design. */
        continue;
      }
      if (error.kind === 'auth') {
        authBroken = true;
        throw error;
      }
      if (error.kind === 'ask_slot_busy' && options.slotAware === true) {
        if (slotAttempts >= config.search.slotRetries) {
          throw error;
        }
        slotAttempts += 1;
        await wait(config.search.slotRetryDelayMs);
        continue;
      }
      if (
        (error.kind === 'rate_limited' ||
          error.kind === 'ldap_unavailable' ||
          error.kind === 'server') &&
        serverAttempts < SERVER_DELAYS_MS.length
      ) {
        const fallback = SERVER_DELAYS_MS[serverAttempts];
        serverAttempts += 1;
        await wait(error.kind === 'rate_limited' ? retryAfterMs(headers, fallback) : fallback);
        continue;
      }
      throw error;
    }
  }

  return {
    listCollections: () =>
      request<DochubCollectionsResponse>({
        route: '/collections',
        url: '/collections',
        method: 'get',
      }),

    getCollectionPage: (collectionId, options) =>
      request<DochubCollectionPage>({
        route: '/collections/{id}',
        url: `/collections/${collectionId}`,
        method: 'get',
        params: {
          ...(options?.limit != null ? { limit: options.limit } : {}),
          ...(options?.cursor != null ? { cursor: options.cursor } : {}),
        },
      }),

    getSummary: (collectionId, documentId) =>
      request<DochubSummaryResponse>({
        route: '/collections/{id}/documents/{doc_id}/summary',
        url: `/collections/${collectionId}/documents/${documentId}/summary`,
        method: 'get',
      }),

    search: (collectionId, query, topK) =>
      request<DochubSearchResponse>({
        route: '/collections/{id}/search',
        url: `/collections/${collectionId}/search`,
        method: 'post',
        data: { query, top_k: topK },
        slotAware: true,
      }),

    getOutline: (documentId) =>
      request<DochubOutline>({
        route: '/documents/{id}/outline',
        url: `/documents/${documentId}/outline`,
        method: 'get',
      }),

    getContent: (documentId, selection, version) =>
      request<DochubContent>({
        route: '/documents/{id}/content',
        url: `/documents/${documentId}/content`,
        method: 'get',
        params: {
          ...('chapter' in selection
            ? { chapter: selection.chapter }
            : {
                page_from: selection.pageFrom,
                ...(selection.pageTo != null ? { page_to: selection.pageTo } : {}),
              }),
          /** Opaque and full of spaces, `:` and `|` — axios encodes it for us. */
          ...(version != null ? { version } : {}),
        },
      }),
  };
}
