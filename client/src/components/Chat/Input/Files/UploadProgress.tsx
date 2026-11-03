import { TooltipAnchor } from '@librechat/client';
import type { TOCRProgress } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useUploadProgress } from '~/hooks/Files/progress';
import { useLocalize } from '~/hooks';

const stageKeys: Record<TOCRProgress['status'], TranslationKeys> = {
  queued: 'com_ui_ocr_queued',
  parsing: 'com_ui_ocr_parsing',
  recognizing: 'com_ui_ocr_recognizing',
  assembling: 'com_ui_ocr_assembling',
  done: 'com_ui_ocr_finishing',
  failed: 'com_ui_ocr_processing',
};

const unitKeys: Record<string, TranslationKeys> = {
  pdf_page: 'com_ui_ocr_pages',
  djvu_page: 'com_ui_ocr_pages',
  section: 'com_ui_ocr_sections',
  slide: 'com_ui_ocr_slides',
  sheet: 'com_ui_ocr_sheets',
};

export default function UploadProgress({
  fileId,
  children,
}: {
  fileId: string;
  children: (subtitle: ReactNode, processing: boolean) => ReactNode;
}) {
  const progress = useUploadProgress(fileId);
  const localize = useLocalize();
  if (progress == null) {
    return children(undefined, false);
  }

  const stage = localize(stageKeys[progress.status]);
  const counts =
    progress.page_count > 0
      ? localize('com_ui_ocr_count', {
          unit: localize(unitKeys[progress.page_unit ?? ''] ?? 'com_ui_ocr_items'),
          done: progress.pages_done,
          total: progress.page_count,
        })
      : '';
  const label =
    progress.status === 'recognizing' && counts
      ? localize('com_ui_ocr_recognizing_count', {
          done: progress.pages_done,
          total: progress.page_count,
        })
      : stage;
  const details = [stage];
  if (counts) {
    details.push(counts);
  }
  if (progress.status === 'queued' && progress.position != null) {
    details.push(localize('com_ui_ocr_queue_position', { position: progress.position }));
  }
  if (progress.figures_total > 0) {
    details.push(
      localize('com_ui_ocr_figures', {
        done: progress.figures_done,
        total: progress.figures_total,
      }),
    );
  }
  if (progress.retry_rounds > 0) {
    details.push(localize('com_ui_ocr_retries', { count: progress.retry_rounds }));
  }
  if (progress.retry_at && Number.isFinite(Date.parse(progress.retry_at))) {
    details.push(
      localize('com_ui_ocr_retry_at', { time: new Date(progress.retry_at).toLocaleString() }),
    );
  }

  return (
    <TooltipAnchor description={details.join(' · ')} tabIndex={0}>
      {children(
        <div role="status" aria-live="polite" className="truncate text-text-secondary">
          {label}
        </div>,
        true,
      )}
    </TooltipAnchor>
  );
}
