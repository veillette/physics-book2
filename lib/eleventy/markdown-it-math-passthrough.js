// markdown-it-math-passthrough.js
// Claims $…$, $$…$$, \(…\), \[…\] spans so no markdown rule touches their contents,
// then renders them verbatim (HTML-escaped) for client-side MathJax.
//
// Why this is mandatory (roadmap section 4.1): markdown-it applies CommonMark
// backslash-escapes and emphasis INSIDE math spans — `\\` (the LaTeX row separator)
// collapses to `\`, destroying every \begin{array}…\end{array}, and `*x*` becomes
// <em>. Kramdown shielded $$…$$ natively, which is why the source works today.
// MathJax reads textContent, so HTML-escaping the delimiters+body is safe.
export default function mathPassthrough(md) {
  // ---- block rule: a line starting with $$ … up to a line ending with $$ ----
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (state.src.slice(start, start + 2) !== '$$') return false;
    let line = startLine;
    let found = state.src.slice(start + 2, state.eMarks[startLine]).trimEnd().endsWith('$$');
    while (!found && ++line <= endLine) {
      if (state.src.slice(state.bMarks[line], state.eMarks[line]).trimEnd().endsWith('$$'))
        found = true;
    }
    if (!found) return false;
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.content = state.getLines(startLine, line + 1, state.tShift[startLine], false);
    token.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  });

  // ---- inline rule: $…$ (pandoc-style), $$…$$, \(…\), \[…\] ----
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    let open, close;
    if (src.startsWith('$$', pos)) {
      open = close = '$$';
    } else if (src[pos] === '$') {
      open = close = '$';
    } else if (src.startsWith('\\(', pos)) {
      open = '\\(';
      close = '\\)';
    } else if (src.startsWith('\\[', pos)) {
      open = '\\[';
      close = '\\]';
    } else return false;
    const contentStart = pos + open.length;
    if (open === '$' && /\s/.test(src[contentStart] ?? '')) return false;
    const end = src.indexOf(close, contentStart);
    if (end === -1 || end === contentStart) return false;
    if (open === '$' && (/\s/.test(src[end - 1]) || /\d/.test(src[end + close.length] ?? '')))
      return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = src.slice(pos, end + close.length);
    }
    state.pos = end + close.length;
    return true;
  });

  md.renderer.rules.math_block = (tokens, i) => md.utils.escapeHtml(tokens[i].content) + '\n';
  md.renderer.rules.math_inline = (tokens, i) => md.utils.escapeHtml(tokens[i].content);
}
