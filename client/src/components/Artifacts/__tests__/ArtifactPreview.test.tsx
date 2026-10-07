import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import { ArtifactPreview } from '../ArtifactPreview';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@codesandbox/sandpack-react/unstyled', () => ({
  SandpackProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sandpack">{children}</div>
  ),
  SandpackPreview: () => null,
}));

const previewRef = createRef<SandpackPreviewRef>() as React.MutableRefObject<SandpackPreviewRef>;
const page = '<!DOCTYPE html><html><body><h1>Привет</h1></body></html>';

const renderPreview = (props: Partial<React.ComponentProps<typeof ArtifactPreview>> = {}) =>
  render(
    <ArtifactPreview
      files={{ 'index.html': page }}
      fileKey="index.html"
      template="static"
      sharedProps={{}}
      previewRef={previewRef}
      startupConfig={{}}
      {...props}
    />,
  );

describe('ArtifactPreview', () => {
  test('renders a static page in a sandboxed iframe without the external bundler', () => {
    renderPreview();

    const frame = screen.getByTestId('static-artifact-preview');
    expect(frame).toHaveAttribute('srcdoc', page);
    expect(frame).toHaveAttribute('title', 'com_ui_preview');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(screen.queryByTestId('sandpack')).toBeNull();
  });

  test('shows the edited code of the page', () => {
    renderPreview({ currentCode: '<p>правка</p>' });
    expect(screen.getByTestId('static-artifact-preview')).toHaveAttribute(
      'srcdoc',
      '<p>правка</p>',
    );
  });

  test('takes index.html when the edited file is markdown source', () => {
    renderPreview({
      files: { 'content.md': '# Заголовок', 'index.html': page },
      fileKey: 'content.md',
    });
    expect(screen.getByTestId('static-artifact-preview')).toHaveAttribute('srcdoc', page);
  });

  test('keeps Sandpack when a self-hosted static bundler is configured', () => {
    renderPreview({ startupConfig: { staticBundlerURL: 'https://bundler.local' } });
    expect(screen.getByTestId('sandpack')).toBeInTheDocument();
    expect(screen.queryByTestId('static-artifact-preview')).toBeNull();
  });

  test('keeps Sandpack for templates that need bundling', () => {
    renderPreview({ template: 'react-ts', files: { 'App.tsx': 'export default 1' } });
    expect(screen.getByTestId('sandpack')).toBeInTheDocument();
  });
});
