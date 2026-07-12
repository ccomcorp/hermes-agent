/**
 * Write Workspace export rendering (Slice L).
 *
 * Renders a write project's markdown to a standalone HTML document, reusing
 * the exact same renderer `write-panel.tsx`'s live preview uses:
 * `CompactMarkdown` (apps/desktop/src/components/chat/compact-markdown.tsx),
 * which wraps Streamdown/remark-gfm. `CompactMarkdown` is a plain React
 * component, so it can run outside of a mounted tree via
 * `react-dom/server`'s `renderToStaticMarkup` — no separate markdown library
 * or main-process rendering is needed.
 *
 * `CompactMarkdown`'s own styling is Tailwind utility classes compiled into
 * the app's bundle, which a standalone exported file does not have — those
 * class names still appear in the markup (harmless) but do nothing on their
 * own. This module's `EXPORT_CSS` is a small, self-contained, tag-based
 * stylesheet (mirroring Kun's own `write-export-service.ts`, which takes the
 * same approach: a bespoke `EXPORT_CSS` constant rather than shipping its
 * app's compiled styles) so the exported document looks reasonable with zero
 * external dependencies, in a browser, in a PDF, or in a DOCX conversion.
 *
 * This module never talks to IPC and never picks a save path — it only
 * builds the `html` string that api.ts's `exportWriteProject` sends to the
 * main process.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CompactMarkdown } from '@/components/chat/compact-markdown'

const EXPORT_CSS = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    padding: 2.5rem 3rem;
    max-width: 52rem;
    margin-inline: auto;
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.65;
    color: #1f2328;
    background: #ffffff;
  }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.3; margin: 1.6em 0 0.5em; }
  h1 { font-size: 1.8em; margin-top: 0; }
  h2 { font-size: 1.4em; }
  h3 { font-size: 1.15em; }
  h4, h5, h6 { font-size: 1em; }
  p { margin: 0 0 1em; }
  a { color: #2563eb; text-decoration: underline; }
  blockquote {
    margin: 1em 0;
    padding: 0.1em 1em;
    border-left: 3px solid #d0d7de;
    color: #57606a;
  }
  ul, ol { margin: 0 0 1em; padding-left: 1.6em; }
  li { margin: 0.25em 0; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 1.5em 0; }
  code {
    font-family: "SF Mono", Consolas, "Liberation Mono", monospace;
    font-size: 0.88em;
    background: #f6f8fa;
    padding: 0.15em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 0.9em 1em;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d0d7de; padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
  thead { background: #f6f8fa; }
  img { max-width: 100%; }
  @media print {
    body { padding: 0.5in 0.6in; max-width: none; }
  }
`

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Renders `markdown` to a complete, standalone HTML document string (doctype
 * through closing `</html>`), ready to hand to `exportWriteProject`.
 */
export function renderWriteExportHtml(markdown: string, title: string): string {
  const bodyFragment = renderToStaticMarkup(createElement(CompactMarkdown, { text: markdown }))
  const safeTitle = escapeHtml(title || 'Untitled document')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${safeTitle}</title>`,
    `  <style>${EXPORT_CSS}</style>`,
    '</head>',
    '<body>',
    `  <article>${bodyFragment}</article>`,
    '</body>',
    '</html>'
  ].join('\n')
}
