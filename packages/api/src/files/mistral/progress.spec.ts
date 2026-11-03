import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TOCRProgress } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import type { ServerRequest } from '~/types';
import { observeOCRProgress } from './progress';
import { uploadMistralOCR } from './crud';

describe('OCR progress HTTP stream', () => {
  let server: ReturnType<typeof createServer>;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let baseURL: string;
  let allowedAddresses: string[];
  const snapshot = {
    status: 'recognizing',
    page_unit: 'pdf_page',
    page_count: 12,
    pages_done: 3,
    figures_total: 2,
    figures_done: 1,
    position: null,
    retry_rounds: 0,
    retry_at: null,
  } satisfies TOCRProgress;

  beforeEach(async () => {
    server = createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    allowedAddresses = [`127.0.0.1:${port}`];
    baseURL = `http://127.0.0.1:${port}/shim/v1/`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const observe = (onProgress: (progress: TOCRProgress | null) => void, signal?: AbortSignal) =>
    observeOCRProgress({
      apiKey: 'test-shim-key',
      baseURL,
      fileId: 'file id',
      allowedAddresses,
      signal: signal ?? new AbortController().signal,
      onProgress,
    });

  it('preserves the URL prefix, credentials and counters across CRLF, UTF-8 and retries', async () => {
    let requestPath: string | undefined;
    let authorization: string | undefined;
    handler = (req, res) => {
      requestPath = req.url;
      authorization = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const first = { ...snapshot, page_unit: 'раздел', job_id: 7, error: 'PRIVATE CONTENT' };
      const frame = Buffer.from(
        `: heartbeat\r\n\r\nevent: progress\r\ndata: ${JSON.stringify(first)}\r\n\r\n`,
      );
      const split = frame.indexOf(Buffer.from('раздел')) + 1;
      res.write(frame.subarray(0, split));
      setImmediate(() => {
        res.write(frame.subarray(split));
        res.write(
          `event: progress\ndata: ${JSON.stringify({ ...snapshot, pages_done: 1, retry_rounds: 1 })}\n\n`,
        );
        res.end(`event: done\ndata: ${JSON.stringify({ ...snapshot, status: 'done' })}\n\n`);
      });
    };
    const updates: Array<TOCRProgress | null> = [];
    await observe((progress) => updates.push(progress));

    expect(requestPath).toBe('/shim/v1/files/file%20id/events');
    expect(authorization).toBe('Bearer test-shim-key');
    expect(updates).toEqual([
      { ...snapshot, page_unit: 'раздел' },
      { ...snapshot, pages_done: 1, retry_rounds: 1 },
      { ...snapshot, status: 'done' },
    ]);
    expect(JSON.stringify(updates)).not.toMatch(/PRIVATE|job_id|error/);
  });

  it('accepts an immediately completed cached job', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: done\ndata: ${JSON.stringify({ ...snapshot, status: 'done' })}\n\n`);
    };
    const onProgress = jest.fn();
    await observe(onProgress);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({ ...snapshot, status: 'done' });
  });

  it.each([
    [404, 'application/json', '{"detail":"unsupported endpoint"}'],
    [200, 'application/json', '{}'],
    [200, 'text/event-stream', 'event: error\ndata: {"detail":"PRIVATE","job":{}}\n\n'],
    [200, 'text/event-stream', 'event: progress\ndata: invalid json\n\n'],
    [
      200,
      'text/event-stream',
      'event: progress\ndata: {"status":"recognizing","pages_done":-1}\n\n',
    ],
    [200, 'text/event-stream', ': heartbeat\n\n'],
  ])('degrades to ordinary processing for HTTP %s / %s', async (status, contentType, body) => {
    handler = (_req, res) => {
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(body);
    };
    const onProgress = jest.fn();
    await expect(observe(onProgress)).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(null);
  });

  it('closes an active connection when the upload disconnects', async () => {
    const controller = new AbortController();
    let closed: Promise<unknown> | undefined;
    handler = (_req, res) => {
      closed = once(res, 'close');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: progress\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    const onProgress = jest.fn(() => controller.abort());
    await observe(onProgress, controller.signal);
    await closed;
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('does not connect for an already aborted upload', async () => {
    const onProgress = jest.fn();
    await observe(onProgress, AbortSignal.abort());
    expect(onProgress).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'disabled', 'unsupported'])(
    'keeps the complete upload / URL / OCR / cleanup flow working with progress %s',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'ocr-progress-'));
      const path = join(directory, 'scan.pdf');
      await writeFile(path, 'test document');
      const calls: string[] = [];
      const updates: Array<TOCRProgress | null> = [];
      let release: () => void = () => undefined;
      const progressReceived = new Promise<void>((resolve) => {
        release = resolve;
      });
      let progressClosed: Promise<unknown> | undefined;
      handler = (req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url === '/shim/v1/files' && req.method === 'POST') {
          req.resume();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ id: 'file-123' }));
          return;
        }
        if (req.url?.startsWith('/shim/v1/files/file-123/url')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ url: `${baseURL}files/file-123/raw` }));
          return;
        }
        if (req.url === '/shim/v1/files/file-123/events') {
          if (mode === 'unsupported') {
            res.writeHead(404);
            res.end();
            return;
          }
          progressClosed = once(res, 'close');
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`event: progress\ndata: ${JSON.stringify(snapshot)}\n\n`);
          return;
        }
        if (req.url === '/shim/v1/ocr') {
          req.resume();
          const finish = () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ pages: [{ index: 0, markdown: 'Recognized text' }] }));
          };
          if (mode === 'disabled') {
            finish();
          } else {
            void progressReceived.then(finish);
          }
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end('{}');
      };
      try {
        const result = await uploadMistralOCR({
          req: {
            user: { id: 'test-user' },
            config: {
              ocr: {
                apiKey: 'test-key',
                baseURL: baseURL.replace(/\/$/, ''),
                allowedAddresses,
                progressEnabled: mode !== 'disabled',
              },
            },
          } as ServerRequest,
          file: {
            path,
            originalname: 'scan.pdf',
            mimetype: 'application/pdf',
          } as Express.Multer.File,
          loadAuthValues: async () => ({}),
          onProgress: (update) => {
            updates.push(update);
            release();
          },
        });
        await progressClosed;
        expect(result.text).toBe('Recognized text\n\n');
        expect(calls).toContain('POST /shim/v1/ocr');
        expect(calls[calls.length - 1]).toBe('DELETE /shim/v1/files/file-123');
        if (mode === 'disabled') {
          expect(calls).not.toContain('GET /shim/v1/files/file-123/events');
          expect(updates).toEqual([]);
        } else {
          expect(updates).toEqual([mode === 'enabled' ? snapshot : null]);
        }
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
});
