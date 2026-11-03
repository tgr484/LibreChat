import { FileSources } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import ImagePreview from './ImagePreview';
import RemoveFile from './RemoveFile';

const Image = ({
  imageBase64,
  url,
  onDelete,
  progress = 1,
  subtitle,
  processing = false,
  source = FileSources.local,
}: {
  imageBase64?: string;
  url?: string;
  onDelete: () => void;
  progress: number; // between 0 and 1
  source?: FileSources;
  subtitle?: ReactNode;
  processing?: boolean;
}) => {
  return (
    <div className="group relative inline-block text-sm text-text-secondary">
      <div className="relative overflow-hidden rounded-2xl border border-border-medium">
        <ImagePreview
          source={source}
          imageBase64={imageBase64}
          url={url}
          progress={progress}
          processing={processing}
        />
      </div>
      {subtitle && <div className="max-w-56 text-xs">{subtitle}</div>}
      <RemoveFile onRemove={onDelete} />
    </div>
  );
};

export default Image;
