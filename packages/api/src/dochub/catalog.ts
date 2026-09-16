import type {
  DochubCollectionSummary,
  DochubCollectionsResponse,
  DochubDocumentEntry,
  DochubDocumentRef,
  DochubSearchHit,
} from './types';
import type { DochubClient } from './client';

export type DochubCollectionResolution =
  | { ok: true; id: number; name: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: DochubCollectionSummary[] };

export type DochubDocumentResolution =
  | { ok: true; ref: DochubDocumentRef }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: DochubDocumentRef[] };

export interface DochubCatalog {
  listCollections(): Promise<DochubCollectionsResponse>;
  resolveCollection(input: string): Promise<DochubCollectionResolution>;
  /** Documents of a collection, by `seq` (the number the user sees) or by title. */
  resolveDocument(collectionId: number, input: string): Promise<DochubDocumentResolution>;
  indexDocuments(collectionId: number, limit?: number): Promise<DochubDocumentRef[]>;
  registerHits(collectionId: number, hits: readonly DochubSearchHit[]): void;
  /** True when this document id came from this collection's listing or search. */
  isInCollection(collectionId: number, documentId: number): boolean;
}

/** Shared between the tool calls of one chat turn so a listing is fetched once. */
export interface DochubCatalogStore {
  collections?: DochubCollectionsResponse;
  documents: Map<number, Map<number, DochubDocumentRef>>;
  indexed: Set<number>;
}

export function createDochubCatalogStore(): DochubCatalogStore {
  return { documents: new Map(), indexed: new Set() };
}

/** Page size and page count are bounded: a huge collection must not eat the budget. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ');
}

function allCollections(response: DochubCollectionsResponse): DochubCollectionSummary[] {
  return [...response.my, ...response.shared_with_me, ...response.public];
}

function toRef(
  collectionId: number,
  collectionName: string,
  entry: DochubDocumentEntry,
): DochubDocumentRef {
  return {
    collectionId,
    collectionName,
    seq: entry.seq,
    id: entry.id,
    title: entry.title,
    canOpen: entry.can_open,
  };
}

export function createDochubCatalog(params: {
  client: DochubClient;
  store?: DochubCatalogStore;
}): DochubCatalog {
  const { client } = params;
  const store = params.store ?? createDochubCatalogStore();
  const names = new Map<number, string>();

  const documentsOf = (collectionId: number): Map<number, DochubDocumentRef> => {
    const existing = store.documents.get(collectionId);
    if (existing) {
      return existing;
    }
    const created = new Map<number, DochubDocumentRef>();
    store.documents.set(collectionId, created);
    return created;
  };

  const listCollections = async (): Promise<DochubCollectionsResponse> => {
    if (!store.collections) {
      store.collections = await client.listCollections();
      for (const collection of allCollections(store.collections)) {
        names.set(collection.id, collection.name);
      }
    }
    return store.collections;
  };

  const indexDocuments = async (
    collectionId: number,
    limit = PAGE_SIZE * MAX_PAGES,
  ): Promise<DochubDocumentRef[]> => {
    const known = documentsOf(collectionId);
    if (store.indexed.has(collectionId)) {
      return [...known.values()].sort((left, right) => left.seq - right.seq);
    }

    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && known.size < limit; page++) {
      const current = await client.getCollectionPage(collectionId, {
        limit: Math.min(PAGE_SIZE, limit - known.size),
        cursor,
      });
      names.set(collectionId, current.name);
      for (const entry of current.documents) {
        known.set(entry.id, toRef(collectionId, current.name, entry));
      }
      if (current.next_cursor == null) {
        /** Only a listing walked to its end may be trusted as complete. */
        store.indexed.add(collectionId);
        break;
      }
      cursor = current.next_cursor;
    }
    return [...known.values()].sort((left, right) => left.seq - right.seq);
  };

  return {
    listCollections,
    indexDocuments,

    /**
     * The user names a collection in words; DocHub speaks ids. Ids are still
     * checked against the listing, so a model cannot probe arbitrary ones.
     */
    resolveCollection: async (input) => {
      const response = await listCollections();
      const collections = allCollections(response);
      const wanted = normalizeName(input);

      const byId = /^\d+$/.test(wanted)
        ? collections.find((collection) => collection.id === Number(wanted))
        : undefined;
      if (byId) {
        return { ok: true, id: byId.id, name: byId.name };
      }

      const exact = collections.filter((collection) => normalizeName(collection.name) === wanted);
      const matches =
        exact.length > 0
          ? exact
          : collections.filter((collection) => normalizeName(collection.name).includes(wanted));

      if (matches.length === 1) {
        return { ok: true, id: matches[0].id, name: matches[0].name };
      }
      if (matches.length === 0) {
        return { ok: false, reason: 'not_found', candidates: collections.slice(0, 20) };
      }
      return { ok: false, reason: 'ambiguous', candidates: matches.slice(0, 20) };
    },

    resolveDocument: async (collectionId, input) => {
      const wanted = normalizeName(input);
      const seq = /^(?:№\s*)?(\d+)$/.exec(wanted)?.[1];

      const known = documentsOf(collectionId);
      const bySeq = (value: number) => [...known.values()].find((ref) => ref.seq === value);

      if (seq != null) {
        const wantedSeq = Number(seq);
        let hit = bySeq(wantedSeq);
        if (hit == null) {
          await indexDocuments(collectionId);
          hit = bySeq(wantedSeq);
        }
        if (hit != null) {
          return { ok: true, ref: hit };
        }
        return { ok: false, reason: 'not_found', candidates: [...known.values()].slice(0, 20) };
      }

      await indexDocuments(collectionId);
      const refs = [...known.values()];
      const exact = refs.filter((ref) => normalizeName(ref.title) === wanted);
      const matches =
        exact.length > 0 ? exact : refs.filter((ref) => normalizeName(ref.title).includes(wanted));

      if (matches.length === 1) {
        return { ok: true, ref: matches[0] };
      }
      if (matches.length === 0) {
        return { ok: false, reason: 'not_found', candidates: refs.slice(0, 20) };
      }
      return { ok: false, reason: 'ambiguous', candidates: matches.slice(0, 20) };
    },

    /**
     * Search can surface a document that no listing page carries (one without a
     * summary), and reading it is legitimate — so hits join the index too.
     */
    registerHits: (collectionId, hits) => {
      const known = documentsOf(collectionId);
      const collectionName = names.get(collectionId) ?? '';
      for (const hit of hits) {
        known.set(hit.id, toRef(collectionId, collectionName, hit));
      }
    },

    /**
     * DocHub's `/documents/{id}/*` routes are not scoped to a collection, so the
     * scoping is ours: a document is readable only if it came from this
     * collection's listing or search.
     */
    isInCollection: (collectionId, documentId) =>
      store.documents.get(collectionId)?.has(documentId) === true,
  };
}
