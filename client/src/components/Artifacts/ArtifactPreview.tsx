import React, { memo, useMemo, type MutableRefObject } from 'react';
import { SandpackPreview, SandpackProvider } from '@codesandbox/sandpack-react/unstyled';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import type { SandpackStartupConfig } from '~/utils/artifacts';
import type { ArtifactFiles } from '~/common';
import { sharedFiles, buildSandpackOptions } from '~/utils/artifacts';
import { useLocalize } from '~/hooks';

type PreviewFile = string | { code?: string } | undefined;

const fileCode = (file: PreviewFile): string =>
  typeof file === 'string' ? file : (file?.code ?? '');

/**
 * A static page needs no bundling, yet Sandpack's `static` template still
 * loads its runtime from `sandpack-static-server.codesandbox.io`: on a closed
 * network that iframe never loads and the preview stays black. Without a
 * self-hosted `SANDPACK_STATIC_BUNDLER_URL` the page is rendered directly in
 * an iframe on an opaque origin — scripts run, but cannot reach the app.
 */
const StaticPreview = memo(function StaticPreview({ html }: { html: string }) {
  const localize = useLocalize();
  return (
    <iframe
      title={localize('com_ui_preview')}
      srcDoc={html}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      className="h-full w-full border-0 bg-white"
      data-testid="static-artifact-preview"
    />
  );
});

export const ArtifactPreview = memo(function ({
  files,
  fileKey,
  template,
  sharedProps,
  previewRef,
  currentCode,
  startupConfig,
}: {
  files: ArtifactFiles;
  fileKey: string;
  template: SandpackProviderProps['template'];
  sharedProps: Partial<SandpackProviderProps>;
  previewRef: MutableRefObject<SandpackPreviewRef>;
  currentCode?: string;
  startupConfig?: SandpackStartupConfig;
}) {
  const artifactFiles = useMemo(() => {
    if (Object.keys(files).length === 0) {
      return files;
    }
    const code = currentCode ?? '';
    if (!code) {
      return files;
    }
    return {
      ...files,
      [fileKey]: { code },
    };
  }, [currentCode, files, fileKey]);

  const options: SandpackProviderProps['options'] = useMemo(
    () => buildSandpackOptions(template, startupConfig),
    [startupConfig, template],
  );

  if (Object.keys(artifactFiles).length === 0) {
    return null;
  }

  if (template === 'static' && !startupConfig?.staticBundlerURL) {
    const pages = artifactFiles as Record<string, PreviewFile>;
    return <StaticPreview html={fileCode(pages['index.html'] ?? pages[fileKey])} />;
  }

  return (
    <SandpackProvider
      files={{ ...artifactFiles, ...sharedFiles }}
      options={options}
      {...sharedProps}
      template={template}
    >
      <SandpackPreview
        showOpenInCodeSandbox={false}
        showRefreshButton={false}
        tabIndex={0}
        ref={previewRef}
      />
    </SandpackProvider>
  );
});
