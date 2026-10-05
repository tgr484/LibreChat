import type { DochubClient } from './client';
import type { DochubContent } from './types';

const TTL_MS = 10 * 60 * 1000;
/** A chapter is at most 30 000 characters: the cache stays within a few tens of MB. */
const MAX_ENTRIES = 200;

interface Entry {
  expires: number;
  content: DochubContent;
}

/** Insertion order doubles as recency: a hit is re-inserted at the end. */
const entries = new Map<string, Entry>();

function read(key: string, now: number): DochubContent | undefined {
  const entry = entries.get(key);
  if (!entry) {
    return undefined;
  }
  entries.delete(key);
  if (entry.expires <= now) {
    return undefined;
  }
  entries.set(key, entry);
  return entry.content;
}

function write(key: string, content: DochubContent, now: number): void {
  entries.delete(key);
  entries.set(key, { expires: now + TTL_MS, content });
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) {
      break;
    }
    entries.delete(oldest);
  }
}

/**
 * Serves repeated chapter reads from memory: an agent often reads the same
 * document several times in one conversation. Only versioned chapter reads
 * are cached — the version comes from an outline fetched on every call, so
 * DocHub still checks access and a changed document never hits a stale entry.
 * Keyed by the DocHub login: one user's reads are never served to another.
 */
export function withContentCache(client: DochubClient, sub: string): DochubClient {
  return {
    ...client,
    getContent: async (documentId, selection, version) => {
      if (version == null || !('chapter' in selection)) {
        return client.getContent(documentId, selection, version);
      }
      const key = `${sub}\u0000${documentId}\u0000${version}\u0000${selection.chapter}`;
      const cached = read(key, Date.now());
      if (cached) {
        return cached;
      }
      const content = await client.getContent(documentId, selection, version);
      if (content.content_version === version) {
        write(key, content, Date.now());
      }
      return content;
    },
  };
}

/** Test seam. */
export function clearContentCache(): void {
  entries.clear();
}
