const { v4 } = require('uuid');
const { FileContext } = require('librechat-data-provider');
const { getStorageMetadata } = require('@librechat/api');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { getRetentionExpiry } = require('./retention');
const { getStrategyFunctions } = require('./strategies');
const db = require('~/models');

/**
 * Persists a file a tool generated on the server (e.g. `create_presentation`)
 * in the configured storage and records it as a message attachment, so it is
 * downloadable from the chat and listed in the user's files.
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
  const file_id = v4();
  const source = getFileStrategy(appConfig, { context: FileContext.message_attachment });
  const { saveBuffer } = getStrategyFunctions(source);
  const filepath = await saveBuffer({
    userId: req.user.id,
    fileName: `${file_id}__${filename}`,
    buffer,
    basePath: 'uploads',
    tenantId: req.user.tenantId,
  });
  return await db.createFile(
    {
      file_id,
      filepath,
      ...getStorageMetadata({ filepath, source }),
      filename,
      type,
      source,
      bytes: buffer.length,
      object: 'file',
      context: FileContext.message_attachment,
      text,
      textFormat,
      user: req.user.id,
      tenantId: req.user.tenantId,
      ...(await getRetentionExpiry(req)),
    },
    true,
  );
}

module.exports = { saveGeneratedFile };
