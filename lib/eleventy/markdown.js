// markdown.js — builds the configured markdown-it instance used by BOTH
// eleventy.config.js (via setLibrary) and the pipeline fixture tests, so the two
// can never drift. Plugin order matters: mathPassthrough must run first so it
// claims math spans before any other rule can mangle them (roadmap section 4.1).
import markdownIt from 'markdown-it';
import markdownItAttrs from 'markdown-it-attrs';
import markdownItAnchor from 'markdown-it-anchor';
import markdownItContainer from 'markdown-it-container';
import markdownItDeflist from 'markdown-it-deflist';
import markdownItFootnote from 'markdown-it-footnote';
import mathPassthrough from './markdown-it-math-passthrough.js';
import { kramdownSlugify } from './kramdown-slugify.js';
import { registerContainers } from './containers.js';

export function createMarkdown() {
  const md = markdownIt({
    html: true, // raw HTML passes through (titles, inner divs)
    breaks: false,
    linkify: false, // Kramdown GFM does not autolink bare URLs — parity (D8)
    typographer: true, // Kramdown smart-quotes by default — parity (D7)
  })
    .use(mathPassthrough) // MUST be first
    .use(markdownItDeflist)
    .use(markdownItFootnote)
    .use(markdownItAttrs, {
      leftDelimiter: '{:',
      rightDelimiter: '}',
      allowedAttributes: ['id', 'class', 'height', 'width', /^data-.*$/],
    })
    .use(markdownItAnchor, {
      slugify: kramdownSlugify,
      level: [1, 2, 3, 4, 5, 6],
      tabIndex: false, // Kramdown adds only id=, no tabindex — parity
    });
  registerContainers(md, markdownItContainer);
  return md;
}
