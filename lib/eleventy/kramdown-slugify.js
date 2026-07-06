// kramdown-slugify.js — replicates Kramdown's auto_id heading-id algorithm so that
// markdown-it-anchor produces the same ids Jekyll did (roadmap section 4.2).
// Cross-references and the parity comparator depend on these matching exactly.
export function kramdownSlugify(text) {
  const id = text
    .replace(/[^a-zA-Z0-9 -]/g, '') // drop everything but letters, digits, spaces, dashes
    .replace(/^[^a-zA-Z]+/, '') // strip up to the first letter
    .replace(/ +/g, '-')
    .toLowerCase();
  return id || 'section';
}
