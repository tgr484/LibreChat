import { createElement } from 'react';
import remarkGfm from 'remark-gfm';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { highContrastDarkTheme, highContrastLightTheme } from '@librechat/client';
import type { IThemeRGB } from '@librechat/client';

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Allowlist-based URL validator for markdown artifact rendering. */
export const isSafeUrl = (url: string): boolean => {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('.')) {
    return true;
  }
  try {
    return SAFE_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
};

const markdownCSS = `
/* GitHub Markdown CSS - Light theme base */
.markdown-body {
  -ms-text-size-adjust: 100%;
  -webkit-text-size-adjust: 100%;
  line-height: 1.5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  word-wrap: break-word;
  color: #24292f;
  background-color: #ffffff;
}

.markdown-body h1, .markdown-body h2 {
  border-bottom: 1px solid #d0d7de;
  margin: 0.6em 0;
}

.markdown-body h1 { font-size: 2em; margin: 0.67em 0; }
.markdown-body h2 { font-size: 1.5em; }
.markdown-body h3 { font-size: 1.25em; }
.markdown-body h4 { font-size: 1em; }
.markdown-body h5 { font-size: 0.875em; }
.markdown-body h6 { font-size: 0.85em; }

.markdown-body ul, .markdown-body ol {
  list-style: revert !important;
  padding-left: 2em !important;
  margin-top: 0;
  margin-bottom: 16px;
}

.markdown-body ul { list-style-type: disc !important; }
.markdown-body ol { list-style-type: decimal !important; }
.markdown-body ul ul { list-style-type: circle !important; }
.markdown-body ul ul ul { list-style-type: square !important; }

.markdown-body li { margin-top: 0.25em; }

.markdown-body li:has(> input[type="checkbox"]) {
  list-style-type: none !important;
}

.markdown-body li > input[type="checkbox"] {
  margin-right: 0.75em;
  margin-left: -1.5em;
  vertical-align: middle;
  pointer-events: none;
  width: 16px;
  height: 16px;
}

.markdown-body .task-list-item {
  list-style-type: none !important;
}

.markdown-body .task-list-item > input[type="checkbox"] {
  margin-right: 0.75em;
  margin-left: -1.5em;
  vertical-align: middle;
  pointer-events: none;
  width: 16px;
  height: 16px;
}

.markdown-body code {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  border-radius: 6px;
  background-color: rgba(175, 184, 193, 0.2);
  color: #24292f;
  font-family: ui-monospace, monospace;
  white-space: pre-wrap;
}

.markdown-body pre {
  padding: 16px;
  overflow: auto;
  font-size: 85%;
  line-height: 1.45;
  border-radius: 6px;
  margin-top: 0;
  margin-bottom: 16px;
  background-color: #f6f8fa;
  color: #24292f;
}

.markdown-body pre code {
  display: inline-block;
  padding: 0;
  margin: 0;
  overflow: visible;
  line-height: inherit;
  word-wrap: normal;
  background-color: transparent;
  border: 0;
}

.markdown-body a {
  text-decoration: none;
  color: #0969da;
}

.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body table {
  border-spacing: 0;
  border-collapse: collapse;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
}

.markdown-body table thead {
  background-color: #f6f8fa;
}

.markdown-body table th, .markdown-body table td {
  padding: 6px 13px;
  border: 1px solid #d0d7de;
}

.markdown-body blockquote {
  padding: 0 1em;
  border-left: 0.25em solid #d0d7de;
  margin: 0 0 16px 0;
  color: #57606a;
}

.markdown-body hr {
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  border: 0;
  background-color: #d0d7de;
}

.markdown-body img {
  max-width: 100%;
  box-sizing: content-box;
}

/* Dark theme */
@media (prefers-color-scheme: dark) {
  .markdown-body {
    color: #c9d1d9;
    background-color: #0d1117;
  }

  .markdown-body h1, .markdown-body h2 {
    border-bottom-color: #21262d;
  }

  .markdown-body code {
    background-color: rgba(110, 118, 129, 0.4);
    color: #c9d1d9;
  }

  .markdown-body pre {
    background-color: #161b22;
    color: #c9d1d9;
  }

  .markdown-body a {
    color: #58a6ff;
  }

  .markdown-body table thead {
    background-color: #161b22;
  }

  .markdown-body table th, .markdown-body table td {
    border-color: #30363d;
  }

  .markdown-body blockquote {
    border-left-color: #3b434b;
    color: #8b949e;
  }

  .markdown-body hr {
    background-color: #21262d;
  }
}

/* Scrollbar */
::-webkit-scrollbar { height: 0.1em; width: 0.5rem; }
::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.1); border-radius: 9999px; }
::-webkit-scrollbar-track { background-color: transparent; border-radius: 9999px; }
@media (prefers-color-scheme: dark) {
  ::-webkit-scrollbar-thumb { background-color: hsla(0,0%,100%,0.1); }
}
* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.1) transparent; }
@media (prefers-color-scheme: dark) {
  * { scrollbar-color: hsla(0,0%,100%,0.1) transparent; }
}
`;

/** Single line breaks become `<br>`, as chat messages read them (marked's `breaks: true`). */
type MdastNode = { type: string; value?: string; children?: MdastNode[] };

const SKIP_BREAKS = new Set(['code', 'inlineCode', 'html']);

function softBreaks(node: MdastNode): void {
  if (!node.children || SKIP_BREAKS.has(node.type)) {
    return;
  }
  node.children = node.children.flatMap((child): MdastNode[] => {
    if (child.type !== 'text' || !child.value?.includes('\n')) {
      softBreaks(child);
      return [child];
    }
    return child.value
      .split('\n')
      .flatMap((line, index): MdastNode[] =>
        index === 0
          ? [{ type: 'text', value: line }]
          : [{ type: 'break' }, { type: 'text', value: line }],
      );
  });
}

const remarkSoftBreaks = () => softBreaks;

/**
 * The document rendered here, not in the preview: the page then needs no script
 * and no CDN, so it shows on a closed network too. Raw HTML is dropped and
 * unsafe link and image targets are blanked, as the chat itself renders them.
 */
function renderMarkdown(content: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkSoftBreaks],
        skipHtml: true,
        urlTransform: (url: string) => (isSafeUrl(url) ? url : ''),
      },
      content,
    ),
  );
}

/**
 * The stylesheet above is a fixed GitHub palette selected by the iframe's own
 * `prefers-color-scheme`, which no app token reaches. In a contrast mode this
 * block is appended unconditionally, so it also overrides that media query and
 * an explicit contrast choice is honoured whatever the OS is set to. Every
 * colour the media query sets has to be answered here, including the `thead`
 * tint: leaving it would strand #f6f8fa or #161b22 under the new ink. Contrast
 * palettes collapse subtle fills onto the canvas, so the header reads through
 * its bold cells and its border rather than a tint of its own.
 */
function contrastMarkdownCSS(isDarkMode: boolean): string {
  const palette = isDarkMode ? highContrastDarkTheme : highContrastLightTheme;
  const hex = (token: keyof IThemeRGB, fallback: string): string => {
    const channels = palette[token]?.trim().split(/\s+/).map(Number);
    if (channels?.length !== 3 || channels.some(Number.isNaN)) {
      return fallback;
    }
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  };

  const canvas = hex('rgb-surface-primary', isDarkMode ? '#000000' : '#ffffff');
  const ink = hex('rgb-text-primary', isDarkMode ? '#ffffff' : '#000000');
  const link = hex('rgb-link', isDarkMode ? '#8cc8ff' : '#0000cc');
  const border = hex('rgb-border-medium', ink);
  const codeFill = hex('rgb-surface-secondary', canvas);

  return `
.markdown-body { color: ${ink}; background-color: ${canvas}; }
body { background-color: ${canvas}; }
.markdown-body h1, .markdown-body h2 { border-bottom-color: ${border}; }
.markdown-body a, .markdown-body a:hover { color: ${link}; text-decoration: underline; }
.markdown-body table th, .markdown-body table td { border-color: ${border}; }
.markdown-body table thead { background-color: ${canvas}; }
.markdown-body blockquote { border-left-color: ${border}; color: ${ink}; }
.markdown-body hr { background-color: ${border}; }
.markdown-body code, .markdown-body pre { color: ${ink}; background-color: ${codeFill}; }
.markdown-body pre { border: 1px solid ${border}; }
::-webkit-scrollbar-thumb { background-color: ${ink}; }
* { scrollbar-color: ${ink} ${canvas}; }
`;
}

function generateMarkdownHtml(content: string, contrastCSS = ''): string {
  const normalizedContent = content.replace(/^( {2})(-|\d+\.)/gm, '    $2');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown Preview</title>
<style>${markdownCSS}${contrastCSS}</style>
</head>
<body>
<div class="markdown-body" id="content" style="padding:2rem;margin:1rem;min-height:100vh">${renderMarkdown(normalizedContent)}</div>
</body>
</html>`;
}

export const getMarkdownFiles = (
  content: string,
  isDarkMode = false,
  highContrast = false,
): Record<string, string> => {
  const md = content || '# No content provided';
  return {
    'content.md': md,
    'index.html': generateMarkdownHtml(md, highContrast ? contrastMarkdownCSS(isDarkMode) : ''),
  };
};
