// markdown-it-kramdown-typography.js
// Kramdown (parser/typographic_symbol.rb) converts only --- -- ... << >> to typographic
// symbols; it does NOT do markdown-it's extra (c)/(tm)/(r)/(p), +-, or repeat-compression.
// The baseline has 0 "©" but 1549 literal "(c)". So we drop markdown-it's `replacements`
// rule and substitute only what Kramdown does. Smartquotes (also from `typographer:true`)
// is left in place. Substitutions apply to prose text tokens only — math (kdmath_*) and
// code tokens are untouched, exactly as Kramdown leaves math/code spans alone.
const SUBS = { '---': '—', '--': '–', '...': '…' }; // mdash, ndash, hellip
const SUBS_RE = /---|--|\.\.\./g;

export default function kramdownTypography(md) {
  md.disable('replacements');
  md.core.ruler.after('inline', 'kramdown_typographic_syms', state => {
    for (const tok of state.tokens) {
      if (tok.type !== 'inline' || !tok.children) continue;
      for (const child of tok.children) {
        if (child.type === 'text' && child.content) {
          child.content = child.content.replace(SUBS_RE, m => SUBS[m]);
        }
      }
    }
  });
}
