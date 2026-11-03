import { createInterface } from 'node:readline';
import { ocrProgressSchema } from 'librechat-data-provider';
import type { TOCRProgress } from 'librechat-data-provider';
import type { AxiosRequestConfig } from 'axios';
import type { Readable } from 'node:stream';
import { applySSRFSafeAgentIfDirect } from '~/auth/agent';
import { applyAxiosProxyConfig } from '~/utils/proxy';
import { createAxiosInstance } from '~/utils/axios';

const axios = createAxiosInstance();
const PROGRESS_TIMEOUT_MS = 45_000;
const MAX_EVENT_LENGTH = 64 * 1024;

/** Observes optional shim progress without changing the authoritative /ocr result. */
export async function observeOCRProgress({
  apiKey,
  baseURL,
  fileId,
  allowedAddresses,
  signal,
  onProgress,
}: {
  apiKey: string;
  baseURL: string;
  fileId: string;
  allowedAddresses?: string[] | null;
  signal: AbortSignal;
  onProgress: (progress: TOCRProgress | null) => void;
}): Promise<void> {
  if (signal.aborted) {
    return;
  }

  const url = `${baseURL.replace(/\/+$/, '')}/files/${encodeURIComponent(fileId)}/events`;
  const config: AxiosRequestConfig = {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' },
    responseType: 'stream',
    timeout: PROGRESS_TIMEOUT_MS,
    signal,
    validateStatus: () => true,
  };
  let stream: Readable | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    applyAxiosProxyConfig(config, url);
    applySSRFSafeAgentIfDirect(config, url, allowedAddresses);
    const response = await axios.get<Readable>(url, config);
    stream = response.data;
    if (
      response.status !== 200 ||
      !String(response.headers['content-type']).toLowerCase().startsWith('text/event-stream')
    ) {
      onProgress(null);
      return;
    }

    lines = createInterface({ input: stream, crlfDelay: Infinity });
    let event = '';
    let data = '';
    for await (const line of lines) {
      if (signal.aborted) {
        return;
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        data += `${line.slice(5).trimStart()}\n`;
        if (data.length > MAX_EVENT_LENGTH) {
          throw new Error('OCR progress event exceeds the size limit');
        }
        continue;
      }
      if (line !== '') {
        continue;
      }
      if (event === 'error') {
        onProgress(null);
        return;
      }
      if ((event === 'progress' || event === 'done') && data) {
        const progress = ocrProgressSchema.safeParse(JSON.parse(data));
        if (!progress.success || progress.data.status === 'failed') {
          onProgress(null);
          return;
        }
        onProgress(progress.data);
        if (progress.data.status === 'done') {
          return;
        }
      }
      event = '';
      data = '';
    }
    if (!signal.aborted) {
      onProgress(null);
    }
  } catch {
    if (!signal.aborted) {
      onProgress(null);
    }
  } finally {
    lines?.close();
    stream?.destroy();
  }
}
