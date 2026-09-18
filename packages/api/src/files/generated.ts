import { FileContext } from 'librechat-data-provider';
import type { FileSources } from 'librechat-data-provider';
import type { RetentionExpiry } from './retention';

export interface GeneratedFileRecordInput {
  fileId: string;
  filepath: string;
  filename: string;
  type: string;
  source: FileSources;
  /** From `getStorageMetadata`; empty for every source but S3/CloudFront. */
  storageKey?: string;
  storageRegion?: string;
  bytes: number;
  text: string | null;
  textFormat: 'html' | null;
  userId: string;
  tenantId?: string;
  retention: RetentionExpiry;
}

/** The subset of `IMongoFile` a tool-generated attachment needs; `db.createFile` casts `user` to `Types.ObjectId` on write. */
export interface GeneratedFileRecord {
  file_id: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  filename: string;
  type: string;
  source: FileSources;
  bytes: number;
  object: 'file';
  context: FileContext.message_attachment;
  text: string | null;
  textFormat: 'html' | null;
  user: string;
  tenantId?: string;
  expiredAt?: Date | null;
}

/**
 * Shapes a tool-generated file (e.g. `create_presentation`) into the record
 * `db.createFile` persists — everything but the actual storage write and the
 * Mongo insert, which stay in `/api` alongside `getFileStrategy` and `~/models`.
 */
export function buildGeneratedFileRecord({
  fileId,
  filepath,
  filename,
  type,
  source,
  storageKey,
  storageRegion,
  bytes,
  text,
  textFormat,
  userId,
  tenantId,
  retention,
}: GeneratedFileRecordInput): GeneratedFileRecord {
  return {
    file_id: fileId,
    filepath,
    ...(storageKey ? { storageKey } : {}),
    ...(storageRegion ? { storageRegion } : {}),
    filename,
    type,
    source,
    bytes,
    object: 'file',
    context: FileContext.message_attachment,
    text,
    textFormat,
    user: userId,
    tenantId,
    ...retention,
  };
}
