// Directory data for src/contents/*.md — applies to every content page.
// Enforces the D5 output-path contract: Jekyll maps contents/x.md -> contents/x.html,
// but Eleventy's default would be contents/x/index.html. Overriding permalink to
// `<filePathStem>.html` reproduces the Jekyll URL exactly. Every existing URL,
// anchor, PDF link, and the search index depend on this mapping (roadmap section 2.4).
export default {
  layout: 'page',
  eleventyComputed: {
    permalink: data => `${data.page.filePathStem}.html`,
  },
};
