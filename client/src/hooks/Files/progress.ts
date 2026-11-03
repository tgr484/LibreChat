import { useMemo } from 'react';
import { atom, useAtomValue } from 'jotai';
import type { TOCRProgress } from 'librechat-data-provider';

type ProgressAction =
  | { type: 'start' | 'clear'; fileId: string }
  | { type: 'update'; fileId: string; ocr: TOCRProgress | null };

const progressAtom = atom<ReadonlyMap<string, TOCRProgress | null>>(new Map());

export const updateUploadProgressAtom = atom(null, (get, set, action: ProgressAction) => {
  const previous = get(progressAtom);
  if (action.type === 'update' && !previous.has(action.fileId)) {
    return;
  }
  if (action.type === 'clear' && !previous.has(action.fileId)) {
    return;
  }
  const next = new Map(previous);
  if (action.type === 'clear') {
    next.delete(action.fileId);
  } else {
    next.set(action.fileId, action.type === 'update' ? action.ocr : null);
  }
  set(progressAtom, next);
});

export function useUploadProgress(fileId: string) {
  const selected = useMemo(() => atom((get) => get(progressAtom).get(fileId)), [fileId]);
  return useAtomValue(selected);
}
