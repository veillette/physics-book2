import { HtmlBasePlugin } from '@11ty/eleventy';
import { createMarkdown } from './lib/eleventy/markdown.js';

export default function (eleventyConfig) {
  // Custom markdown-it stack (math passthrough, IAL attrs, Kramdown slugs,
  // containers, deflist, footnotes). Shared with the pipeline tests.
  eleventyConfig.setLibrary('md', createMarkdown());

  // Root-relative URLs get the pathPrefix at build time.
  eleventyConfig.addPlugin(HtmlBasePlugin);

  // window.Book.rootUrl/baseHref must have NO trailing slash (they concatenate
  // with /SUMMARY.html etc.) — roadmap section 2.3.
  eleventyConfig.addFilter('trimSlash', v => String(v).replace(/\/+$/, ''));

  // Passthrough paths are relative to the project root (input is src/).
  eleventyConfig.addPassthroughCopy({
    assets: 'assets', // includes js/mathjax, pwa, pdf (when present)
    resources: 'resources',
    'summary.json': 'summary.json',
    'search_index.json': 'search_index.json', // committed copy for local dev; CI regenerates
  });

  return {
    dir: {
      input: 'src',
      includes: '_includes',
      layouts: '_includes/layouts',
      data: '_data',
    },
    templateFormats: ['md', 'njk', 'html'],
    markdownTemplateEngine: false, // D2: nothing touches markdown bodies (protects math)
    htmlTemplateEngine: 'njk',
    pathPrefix: '/physics-book2/',
  };
}
