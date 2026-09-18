const { v4 } = require('uuid');
const { FileContext } = require('librechat-data-provider');
const { buildGeneratedFileRecord, getStorageMetadata } = require('@librechat/api');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { getRetentionExpiry } = require('./retention');
const { getStrategyFunctions } = require('./strategies');
const db = require('~/models');

/**
 * Persists a file a tool generated on the server (e.g. `create_presentation`)
 * in the configured storage and records it as a message attachment, so it is
 * downloadable from the chat and listed in the user's files. The record shape
 * itself is built by `buildGeneratedFileRecord` in `@librechat/api`; this stays
 * a thin wrapper around the storage write and the Mongo insert.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {Buffer} params.buffer
 * @param {string} params.filename - Already sanitized display name.
 * @param {string} params.type - MIME type.
 * @param {string | null} params.text - Office preview HTML, if rendered.
 * @param {'html' | null} params.textFormat
 * @returns {Promise<MongoFile>}
 */
async function saveGeneratedFile({ req, buffer, filename, type, text, textFormat }) {
  const appConfig = req.config;
  const fileId = v4();
  const source = getFileStrategy(appConfig, { context: FileContext.message_attachment });
  const { saveBuffer } = getStrategyFunctions(source);
  const [filepath, retention] = await Promise.all([
    saveBuffer({
      userId: req.user.id,
      fileName: `${fileId}__${filename}`,
      buffer,
      basePath: 'uploads',
      tenantId: req.user.tenantId,
    }),
    getRetentionExpiry(req),
  ]);
  const record = buildGeneratedFileRecord({
    fileId,
    filepath,
    filename,
    type,
    source,
    ...getStorageMetadata({ filepath, source }),
    bytes: buffer.length,
    text,
    textFormat,
    userId: req.user.id,
    tenantId: req.user.tenantId,
    retention,
  });
  return await db.createFile(record, true);
}

module.exports = { saveGeneratedFile };
