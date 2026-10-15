import { isSafeUrl, getMarkdownFiles } from '../markdown';

describe('isSafeUrl', () => {
  it('allows https URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
  });

  it('allows http URLs', () => {
    expect(isSafeUrl('http://example.com/path')).toBe(true);
  });

  it('allows mailto links', () => {
    expect(isSafeUrl('mailto:user@example.com')).toBe(true);
  });

  it('allows tel links', () => {
    expect(isSafeUrl('tel:+1234567890')).toBe(true);
  });

  it('allows relative paths', () => {
    expect(isSafeUrl('/path/to/page')).toBe(true);
    expect(isSafeUrl('./relative')).toBe(true);
    expect(isSafeUrl('../parent')).toBe(true);
  });

  it('allows anchor links', () => {
    expect(isSafeUrl('#section')).toBe(true);
  });

  it('blocks javascript: protocol', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('blocks javascript: with leading whitespace', () => {
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false);
  });

  it('blocks javascript: with mixed case', () => {
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
  });

  it('blocks data: protocol', () => {
    expect(isSafeUrl('data:text/html,<b>x</b>')).toBe(false);
  });

  it('blocks blob: protocol', () => {
    expect(isSafeUrl('blob:http://example.com/uuid')).toBe(false);
  });

  it('blocks vbscript: protocol', () => {
    expect(isSafeUrl('vbscript:MsgBox("xss")')).toBe(false);
  });

  it('blocks file: protocol', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('blocks empty strings', () => {
    expect(isSafeUrl('')).toBe(false);
  });

  it('blocks whitespace-only strings', () => {
    expect(isSafeUrl('   ')).toBe(false);
  });

  it('blocks unknown/custom protocols', () => {
    expect(isSafeUrl('custom:payload')).toBe(false);
  });
});

describe('markdown artifacts', () => {
  describe('getMarkdownFiles', () => {
    it('should return content.md with the original markdown content', () => {
      const markdown = '# Hello World\n\nThis is a test.';
      const files = getMarkdownFiles(markdown);

      expect(files['content.md']).toBe(markdown);
    });

    it('should return default content when markdown is empty', () => {
      const files = getMarkdownFiles('');

      expect(files['content.md']).toBe('# No content provided');
    });

    it('should include index.html with static markdown rendering', () => {
      const markdown = '# Test';
      const files = getMarkdownFiles(markdown);

      expect(files['index.html']).toContain('<!DOCTYPE html>');
      expect(files['index.html']).toContain('<h1>Test</h1>');
      /** Rendered ahead of time: the page loads nothing, so it works offline. */
      expect(files['index.html']).not.toContain('<script');
      expect(files['index.html']).not.toContain('cdn.');
    });

    it('should only produce content.md and index.html', () => {
      const files = getMarkdownFiles('# Test');
      expect(Object.keys(files).sort()).toEqual(['content.md', 'index.html']);
    });

    it('should include markdown CSS in index.html', () => {
      const files = getMarkdownFiles('# Test');
      expect(files['index.html']).toContain('.markdown-body');
      expect(files['index.html']).toContain('list-style-type: disc');
      expect(files['index.html']).toContain('prefers-color-scheme: dark');
    });

    /** The base sheet picks its palette from the iframe's own
     *  `prefers-color-scheme`, so the contrast block is appended unconditionally
     *  and therefore also overrides that media query. */
    it('appends a contrast override that outranks the media query', () => {
      const standard = getMarkdownFiles('# Test')['index.html'];
      expect(standard).toContain('prefers-color-scheme: dark');
      expect(standard).not.toContain('background-color: #000000');

      const contrastDark = getMarkdownFiles('# Test', true, true)['index.html'];
      const overrideIndex = contrastDark.lastIndexOf('.markdown-body { color: #ffffff');
      expect(overrideIndex).toBeGreaterThan(contrastDark.indexOf('prefers-color-scheme: dark'));
      expect(contrastDark).toContain('background-color: #000000');
      expect(contrastDark).toContain('color: #8cc8ff');

      const contrastLight = getMarkdownFiles('# Test', false, true)['index.html'];
      expect(contrastLight).toContain('.markdown-body { color: #000000');
      expect(contrastLight).toContain('color: #0000cc');
    });

    /** Anything the base sheet colours inside the media query has to be answered
     *  by the appended block, or an explicit contrast choice keeps a GitHub
     *  palette value wherever the override forgot to reach. */
    it('answers every media-query colour in the contrast block', () => {
      const styleOf = (html: string) =>
        html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));
      const baseStyle = styleOf(getMarkdownFiles('# Test')['index.html']);
      const override = styleOf(getMarkdownFiles('# Test', true, true)['index.html']).slice(
        baseStyle.length,
      );

      /** `selector -> property` pairs, one per selector in a comma-separated list. */
      const declarations = (css: string): string[] =>
        [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
          selectors.split(',').flatMap((selector) =>
            body
              .split(';')
              .map((declaration) => declaration.split(':')[0].trim())
              .filter(Boolean)
              .map((property) => `${selector.trim()} -> ${property}`),
          ),
        );

      const answered = new Set(declarations(override));
      const mediaBlocks = [
        ...baseStyle.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/g),
      ];
      expect(mediaBlocks.length).toBeGreaterThan(0);

      const unanswered = mediaBlocks
        .flatMap(([, block]) => declarations(block))
        .filter((declaration) => !answered.has(declaration));
      expect(unanswered).toEqual([]);
    });

    describe('rendering', () => {
      it('keeps backticks, backslashes and dollar signs as text', () => {
        const html = getMarkdownFiles('Price: $100, path C:\\Users, `x`')['index.html'];
        expect(html).toContain('Price: $100, path C:\\Users, <code>x</code>');
      });

      it('renders fenced code with its language class', () => {
        const html = getMarkdownFiles('```js\nconsole.log("test");\n```')['index.html'];
        expect(html).toContain('<code class="language-js">console.log(&quot;test&quot;);');
      });

      it('drops raw HTML, so content cannot inject a script', () => {
        const html = getMarkdownFiles('Some content with </script><script>alert(1)</script>')[
          'index.html'
        ];
        expect(html).not.toContain('<script');
        expect(html).toContain('Some content with');
      });

      it('blanks unsafe link targets and keeps safe ones', () => {
        const html = getMarkdownFiles('[bad](javascript:alert(1)) [good](https://example.com)')[
          'index.html'
        ];
        expect(html).not.toContain('javascript:');
        expect(html).toContain('href="https://example.com"');
      });

      it('renders GFM tables and turns single line breaks into <br>', () => {
        const html = getMarkdownFiles('| a | b |\n|---|---|\n| 1 | 2 |\n\nfirst\nsecond')[
          'index.html'
        ];
        expect(html).toContain('<table>');
        expect(html).toContain('<td>1</td>');
        expect(html).toMatch(/first<br\s*\/?>\s*second/);
      });
    });

    describe('list indentation normalization', () => {
      it('should normalize 2-space indented lists to 4-space', () => {
        const markdown = '- Item 1\n  - Subitem 1\n  - Subitem 2';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
        expect(files['index.html']).toMatch(/<li>Item 1\s*<ul>\s*<li>Subitem 1<\/li>/);
      });

      it('should handle numbered lists with 2-space indents', () => {
        const markdown = '1. First\n  2. Second nested';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
        expect(files['index.html']).toContain('First');
        expect(files['index.html']).toContain('Second nested');
      });

      it('should not affect already 4-space indented lists', () => {
        const markdown = '- Item 1\n    - Subitem 1';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
        expect(files['index.html']).toMatch(/<li>Item 1\s*<ul>\s*<li>Subitem 1<\/li>/);
      });
    });

    describe('edge cases', () => {
      it('should handle very long markdown content', () => {
        const longMarkdown = '# Test\n\n' + 'Lorem ipsum '.repeat(1000);
        const files = getMarkdownFiles(longMarkdown);

        expect(files['content.md']).toBe(longMarkdown);
        expect(files['index.html']).toContain('Lorem ipsum');
      });

      it('should handle markdown with special characters', () => {
        const markdown = '# Test & < > " \'';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });

      it('should handle markdown with unicode characters', () => {
        const markdown = '# 你好 世界 🌍';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });

      it('should handle markdown with only whitespace', () => {
        const markdown = '   \n\n   ';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });

      it('should handle markdown with mixed line endings', () => {
        const markdown = '# Line 1\r\n## Line 2\n### Line 3';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });
    });
  });
});
