import type { DochubClient } from './client';
import type { DochubContent } from './types';
import { clearContentCache, withContentCache } from './cache';

const content = (version: string, chapter: number): DochubContent => ({
  document_id: 103,
  content_version: version,
  chapter,
  page_from: 1,
  page_to: 1,
  chars: 5,
  truncated: false,
  text: `глава ${chapter}`,
});

function countingClient() {
  const calls: string[] = [];
  const client = {
    getContent: async (
      documentId: number,
      selection: { chapter: number } | { pageFrom: number; pageTo?: number },
      version?: string,
    ) => {
      const where = 'chapter' in selection ? `ch${selection.chapter}` : `p${selection.pageFrom}`;
      calls.push(`${documentId}:${where}:${version ?? '-'}`);
      return content(version ?? 'v1', 'chapter' in selection ? selection.chapter : 0);
    },
  } as unknown as DochubClient;
  return { client, calls };
}

beforeEach(() => clearContentCache());

describe('withContentCache', () => {
  it('fetches a versioned chapter once per user', async () => {
    const { client, calls } = countingClient();
    const ivanov = withContentCache(client, 'ivanov');

    await ivanov.getContent(103, { chapter: 0 }, 'v1');
    const again = await ivanov.getContent(103, { chapter: 0 }, 'v1');

    expect(again.text).toBe('глава 0');
    expect(calls).toEqual(['103:ch0:v1']);
  });

  it('never shares a chapter between users or versions', async () => {
    const { client, calls } = countingClient();

    await withContentCache(client, 'ivanov').getContent(103, { chapter: 0 }, 'v1');
    await withContentCache(client, 'petrov').getContent(103, { chapter: 0 }, 'v1');
    await withContentCache(client, 'ivanov').getContent(103, { chapter: 0 }, 'v2');

    expect(calls).toEqual(['103:ch0:v1', '103:ch0:v1', '103:ch0:v2']);
  });

  it('does not cache page ranges or unversioned reads', async () => {
    const { client, calls } = countingClient();
    const cached = withContentCache(client, 'ivanov');

    await cached.getContent(103, { pageFrom: 1 });
    await cached.getContent(103, { pageFrom: 1 });
    await cached.getContent(103, { chapter: 0 });
    await cached.getContent(103, { chapter: 0 });

    expect(calls).toHaveLength(4);
  });

  it('expires entries', async () => {
    const { client, calls } = countingClient();
    const cached = withContentCache(client, 'ivanov');
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    await cached.getContent(103, { chapter: 0 }, 'v1');
    now.mockReturnValue(1_000_000 + 11 * 60 * 1000);
    await cached.getContent(103, { chapter: 0 }, 'v1');
    now.mockRestore();

    expect(calls).toHaveLength(2);
  });
});
