const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { FileContext, FileSources } = require('librechat-data-provider');
const { fileSchema, createMethods } = require('@librechat/data-schemas');

const saved = [];

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: async ({ userId, fileName, buffer, basePath }) => {
      saved.push({ userId, fileName, buffer, basePath });
      return `/${basePath}/${userId}/${fileName}`;
    },
  })),
}));

/** Filled in `beforeAll`, once the File model is registered on the connection. */
jest.mock('~/models', () => ({}));

const { saveGeneratedFile } = require('./generated');
const db = require('~/models');

describe('saveGeneratedFile', () => {
  let mongoServer;
  const userId = new mongoose.Types.ObjectId().toString();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    mongoose.models.File || mongoose.model('File', fileSchema);
    Object.assign(db, createMethods(mongoose, { removeAllPermissions: jest.fn() }));
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('stores the bytes under uploads and records a downloadable attachment with its preview', async () => {
    const buffer = Buffer.from('PK deck');
    const file = await saveGeneratedFile({
      req: { user: { id: userId }, config: { fileStrategy: FileSources.local } },
      buffer,
      filename: 'Итоги.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      text: '<ol class="lc-pptx-list"></ol>',
      textFormat: 'html',
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ userId, basePath: 'uploads', buffer });
    expect(saved[0].fileName).toBe(`${file.file_id}__Итоги.pptx`);

    const [stored] = await db.getFiles({ file_id: file.file_id });
    expect(stored).toMatchObject({
      filename: 'Итоги.pptx',
      filepath: `/uploads/${userId}/${file.file_id}__Итоги.pptx`,
      source: FileSources.local,
      context: FileContext.message_attachment,
      bytes: buffer.length,
      textFormat: 'html',
    });
    expect(stored.user.toString()).toBe(userId);
    /** The attachment streamed to the chat is this record, preview included. */
    expect(file.text).toBe('<ol class="lc-pptx-list"></ol>');
  });
});
