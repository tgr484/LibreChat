/**
 * Response shapes of the DocHub integration API (`/api/integration/v1`).
 * Mirrors `docs/integration-librechat.md` of the DocHub repository; fields the
 * contract guarantees are required here, and only the ones it marks as nullable
 * are `| null`.
 */

import type {
  dochubLimitsSchema,
  dochubAgentSchema,
  dochubSearchSchema,
} from 'librechat-data-provider';
import type { z } from 'zod';

/** Resolved (defaults applied) shapes of the `dochub` block in librechat.yaml. */
export type DochubLimits = z.infer<typeof dochubLimitsSchema>;
export type DochubAgentSettings = z.infer<typeof dochubAgentSchema>;
export type DochubSearchSettings = z.infer<typeof dochubSearchSchema>;

/** Everything a tool call needs, with the key material resolved separately. */
export interface DochubRuntimeConfig {
  baseURL: string;
  issuer: string;
  audience: string;
  keyId: string;
  tokenTtlSeconds: number;
  requestTimeoutMs: number;
  limits: DochubLimits;
  agent: DochubAgentSettings;
  search: DochubSearchSettings;
}

export interface DochubSignedToken {
  token: string;
  jti: string;
}

export type DochubSubject =
  | { ok: true; sub: string; lcUid?: string }
  | { ok: false; reason: 'not_ldap' | 'missing' | 'invalid_format' };

export type DochubErrorKind =
  | 'auth'
  | 'forbidden'
  | 'account_conflict'
  | 'integration_off'
  | 'collection_not_found'
  | 'not_found'
  | 'version_mismatch'
  | 'bad_request'
  | 'rate_limited'
  | 'ask_slot_busy'
  | 'ldap_unavailable'
  | 'misconfigured'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'budget';

export interface DochubCollectionSummary {
  id: number;
  name: string;
  description: string | null;
  document_count: number;
  /** Absent for the user's own collections. */
  owner_username?: string;
}

export interface DochubCollectionsResponse {
  my: DochubCollectionSummary[];
  shared_with_me: DochubCollectionSummary[];
  public: DochubCollectionSummary[];
}

export type DochubDocType =
  | 'report'
  | 'article'
  | 'book'
  | 'publication'
  | 'reference'
  | 'presentation'
  | 'journal';

export interface DochubDocumentEntry {
  /** Number shown to the user in DocHub; the handle both sides cite documents by. */
  seq: number;
  id: number;
  title: string;
  doc_type: DochubDocType | null;
  category_name: string | null;
  summary_preview: string;
  /** False only for another user's private document inside a collection the user belongs to. */
  can_open: boolean;
}

export interface DochubCollectionPage {
  id: number;
  name: string;
  description: string | null;
  owner_username: string | null;
  is_member: boolean;
  documents: DochubDocumentEntry[];
  next_cursor: string | null;
}

export interface DochubSummaryResponse {
  id: number;
  title: string;
  summary: string;
  truncated: boolean;
  can_open: boolean;
}

export interface DochubSearchHit extends DochubDocumentEntry {
  match_reason: string;
  score: number;
  /** Full-text fragment; empty when the document's text is not readable by this user. */
  snippets: string[];
}

export interface DochubSearchResponse {
  collection_id: number;
  query: string;
  /** True when DocHub's query planner was unavailable and results may be coarser. */
  degraded: boolean;
  hits: DochubSearchHit[];
}

export interface DochubChapter {
  index: number;
  heading: string | null;
  chars: number;
  page_from: number | null;
  page_to: number | null;
}

export interface DochubOutline {
  document_id: number;
  title: string;
  /** Opaque; compare for equality and pass back verbatim. */
  content_version: string;
  chapters: DochubChapter[];
}

export interface DochubContent {
  document_id: number;
  content_version: string;
  chapter: number | null;
  page_from: number | null;
  page_to: number | null;
  chars: number;
  truncated: boolean;
  text: string;
}

/** A document the tools are allowed to touch: it came from a listing or a search hit. */
export interface DochubDocumentRef {
  collectionId: number;
  collectionName: string;
  seq: number;
  id: number;
  title: string;
  canOpen: boolean;
}

export interface DochubChapterFinding {
  chapterIndex: number;
  heading: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  /** Empty when the chapter held nothing about the question. */
  text: string;
  truncated: boolean;
}

export interface DochubReadResult {
  ref: DochubDocumentRef;
  source: 'content' | 'summary';
  findings: DochubChapterFinding[];
  synthesis: string;
  chaptersTotal: number;
  chaptersRead: number;
  /** Russian notices for the calling model: budget hits, missing text, degradation. */
  notes: string[];
}

export interface DochubSurveyDocumentResult {
  ref: DochubDocumentRef;
  synthesis: string;
  source: 'content' | 'summary';
  notes: string[];
}

export interface DochubSurveyResult {
  collectionId: number;
  collectionName: string;
  question: string;
  degraded: boolean;
  documents: DochubSurveyDocumentResult[];
  skipped: DochubDocumentRef[];
  synthesis: string;
  notes: string[];
}
