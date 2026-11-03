import { useEffect, useRef } from 'react';
import { useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';

export const useDelayedUploadToast = () => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const uploadTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = uploadTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const determineDelay = (fileSize: number): number => {
    const baseDelay = 5000;
    const additionalDelay = Math.floor(fileSize / 1000000) * 2000;
    return baseDelay + additionalDelay;
  };

  const startUploadTimer = (fileId: string, fileName: string, fileSize: number) => {
    const delay = determineDelay(fileSize);

    clearTimeout(uploadTimers.current.get(fileId));

    const timer = setTimeout(() => {
      uploadTimers.current.delete(fileId);
      const message = localize('com_ui_upload_delay', { 0: fileName });
      showToast({
        message,
        status: 'warning',
        duration: 10000,
      });
    }, delay);

    uploadTimers.current.set(fileId, timer);
  };

  const clearUploadTimer = (fileId: string) => {
    clearTimeout(uploadTimers.current.get(fileId));
    uploadTimers.current.delete(fileId);
  };

  return { startUploadTimer, clearUploadTimer };
};
