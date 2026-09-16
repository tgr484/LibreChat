import type {
  DochubCollectionPage,
  DochubCollectionsResponse,
  DochubDocumentEntry,
  DochubSearchHit,
} from './types';
import type { DochubClient } from './client';
import { createDochubCatalog, createDochubCatalogStore, normalizeName } from './catalog';

const collections: DochubCollectionsResponse = {
  my: [
    { id: 7, name: 'Нефтяное хозяйство 2018', description: null, document_count: 42 },
    { id: 8, name: 'Нефтяное хозяйство 2019', description: null, document_count: 40 },
  ],
  shared_with_me: [
    {
      id: 11,
      name: 'Бурение: инструкции',
      description: 'ё-тест',
      document_count: 4,
      owner_username: 'petrov',
    },
  ],
  public: [
    {
      id: 19,
      name: 'Публичная подшивка',
      description: null,
      document_count: 9,
      owner_username: 's',
    },
  ],
};

const entry = (seq: number, id: number, title: string, canOpen = true): DochubDocumentEntry => ({
  seq,
  id,
  title,
  doc_type: 'report',
  category_name: 'Бурение',
  summary_preview: 'выжимка…',
  can_open: canOpen,
});

interface StubCalls {
  listCollections: number;
  pages: Array<{ collectionId: number; cursor?: string; limit?: number }>;
}

function stubClient(pages: Record<number, DochubCollectionPage[]>): {
  client: DochubClient;
  calls: StubCalls;
} {
  const calls: StubCalls = { listCollections: 0, pages: [] };
  const cursors = new Map<number, number>();

  const client = {
    listCollections: async () => {
      calls.listCollections += 1;
      return collections;
    },
    getCollectionPage: async (
      collectionId: number,
      options?: { limit?: number; cursor?: string },
    ) => {
      calls.pages.push({ collectionId, cursor: options?.cursor, limit: options?.limit });
      const index = options?.cursor == null ? 0 : (cursors.get(collectionId) ?? 0) + 1;
      cursors.set(collectionId, index);
      return pages[collectionId][index];
    },
  } as unknown as DochubClient;

  return { client, calls };
}

const page = (
  id: number,
  name: string,
  documents: DochubDocumentEntry[],
  nextCursor: string | null = null,
): DochubCollectionPage => ({
  id,
  name,
  description: null,
  owner_username: null,
  is_member: true,
  documents,
  next_cursor: nextCursor,
});

describe('normalizeName', () => {
  it('ignores case, ё, quotes and repeated spaces', () => {
    expect(normalizeName('  «Нефтяное   ХОЗЯЙСТВО»  ')).toBe('нефтяное хозяйство');
    expect(normalizeName('Бурёние')).toBe(normalizeName('Бурение'));
  });
});

describe('resolveCollection', () => {
  const build = () => {
    const { client, calls } = stubClient({});
    return { catalog: createDochubCatalog({ client }), calls };
  };

  it('finds a collection by its name as the user typed it', async () => {
    const { catalog } = build();
    await expect(catalog.resolveCollection('нефтяное хозяйство 2018')).resolves.toEqual({
      ok: true,
      id: 7,
      name: 'Нефтяное хозяйство 2018',
    });
  });

  it('finds a collection the user only named in part', async () => {
    const { catalog } = build();
    await expect(catalog.resolveCollection('Бурение')).resolves.toMatchObject({ ok: true, id: 11 });
  });

  it('asks which one when the name fits several', async () => {
    const { catalog } = build();
    const resolution = await catalog.resolveCollection('нефтяное хозяйство');

    expect(resolution).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(resolution.ok === false && resolution.candidates.map((item) => item.id)).toEqual([7, 8]);
  });

  it('returns the list of collections when nothing matches', async () => {
    const { catalog } = build();
    const resolution = await catalog.resolveCollection('отчёты по ГРП');

    expect(resolution).toMatchObject({ ok: false, reason: 'not_found' });
    expect(resolution.ok === false && resolution.candidates).toHaveLength(4);
  });

  /** An id still has to appear in the listing — no probing of arbitrary ids. */
  it('accepts a numeric id only when the user may see that collection', async () => {
    const { catalog } = build();
    await expect(catalog.resolveCollection('19')).resolves.toMatchObject({ ok: true, id: 19 });
    await expect(catalog.resolveCollection('4242')).resolves.toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('fetches the listing once per turn, even across catalogs', async () => {
    const { client, calls } = stubClient({});
    const store = createDochubCatalogStore();

    await createDochubCatalog({ client, store }).resolveCollection('7');
    await createDochubCatalog({ client, store }).resolveCollection('8');

    expect(calls.listCollections).toBe(1);
  });
});

describe('resolveDocument', () => {
  const pages = {
    7: [
      page(7, 'Нефтяное хозяйство 2018', [entry(1, 101, 'Испытания турбодетандера')], 'cursor-1'),
      page(7, 'Нефтяное хозяйство 2018', [
        entry(3, 103, 'Отчёт по бурению', false),
        entry(4, 104, 'Отчёт по бурению — приложение'),
      ]),
    ],
  };

  it('resolves the number the user sees, with or without №', async () => {
    const { client } = stubClient(pages);
    const catalog = createDochubCatalog({ client });

    await expect(catalog.resolveDocument(7, '3')).resolves.toEqual({
      ok: true,
      ref: {
        collectionId: 7,
        collectionName: 'Нефтяное хозяйство 2018',
        seq: 3,
        id: 103,
        title: 'Отчёт по бурению',
        canOpen: false,
      },
    });
    await expect(catalog.resolveDocument(7, '№ 1')).resolves.toMatchObject({
      ok: true,
      ref: { id: 101 },
    });
  });

  it('walks every page of the collection', async () => {
    const { client, calls } = stubClient(pages);
    const catalog = createDochubCatalog({ client });

    await catalog.resolveDocument(7, '4');
    expect(calls.pages).toHaveLength(2);
    expect(calls.pages[1].cursor).toBe('cursor-1');
  });

  it('resolves a title and asks when a title fits several documents', async () => {
    const { client } = stubClient(pages);
    const catalog = createDochubCatalog({ client });

    await expect(catalog.resolveDocument(7, 'Испытания турбодетандера')).resolves.toMatchObject({
      ok: true,
      ref: { seq: 1 },
    });
    await expect(catalog.resolveDocument(7, 'Отчёт по бурению')).resolves.toMatchObject({
      ok: true,
      ref: { seq: 3 },
    });
    await expect(catalog.resolveDocument(7, 'бурению')).resolves.toMatchObject({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('reports a number the collection does not have', async () => {
    const { client } = stubClient(pages);
    const catalog = createDochubCatalog({ client });

    await expect(catalog.resolveDocument(7, '99')).resolves.toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('collection scoping', () => {
  const hit = (seq: number, id: number, title: string): DochubSearchHit => ({
    ...entry(seq, id, title),
    match_reason: 'похож по смыслу',
    score: 0.7,
    snippets: [],
  });

  it('only admits documents this collection actually showed', async () => {
    const { client } = stubClient({
      7: [page(7, 'Нефтяное хозяйство 2018', [entry(1, 101, 'А')])],
    });
    const catalog = createDochubCatalog({ client });

    await catalog.indexDocuments(7);

    expect(catalog.isInCollection(7, 101)).toBe(true);
    expect(catalog.isInCollection(7, 999)).toBe(false);
    expect(catalog.isInCollection(8, 101)).toBe(false);
  });

  /** A search can surface a document no listing page carries (it has no summary). */
  it('admits a document that only search found', async () => {
    const { client } = stubClient({ 7: [page(7, 'Нефтяное хозяйство 2018', [])] });
    const catalog = createDochubCatalog({ client });

    catalog.registerHits(7, [hit(12, 512, 'Без выжимки')]);

    expect(catalog.isInCollection(7, 512)).toBe(true);
    await expect(catalog.resolveDocument(7, '12')).resolves.toMatchObject({
      ok: true,
      ref: { id: 512 },
    });
  });
});
