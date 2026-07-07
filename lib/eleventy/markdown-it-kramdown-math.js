// markdown-it-kramdown-math.js
// Reproduces Kramdown's math output (with math_engine: null) BYTE-FOR-BYTE so the
// Eleventy build matches the Jekyll baseline. Verified against kramdown 2.5.1:
//   parser/kramdown/math.rb  — only $$…$$ is math; content is .strip'd; a $$…$$
//     that is its own block (block boundary before AND after) is :block, else :span.
//   converter/html.rb convert_math — with no math engine:
//     :block  -> <div class="kdmath">$$\n{value}\n$$</div>
//     :span   -> <span class="kdmath">${value}$</span>
//     format_as_(block|span)_html insert the body RAW (unescaped) — the baseline
//     really does contain raw & and < inside kdmath (e.g. array separators, `<f`).
//
// Consequences that make this correct rather than the roadmap's verbatim passthrough:
//   * inline $$Q $$ must become <span class="kdmath">$Q$</span> (single $, trimmed) so
//     MathJax renders it INLINE, not as centred display math.
//   * single $, \(, \[ are NOT math in Kramdown — we leave them to markdown-it's
//     escape rule, whose escaped-char set matches Kramdown's for ()[] etc., so
//     `\(v \)` in body text collapses to `(v )` in BOTH engines.
//   * $$…$$ inside raw HTML (e.g. <div class="equation">) is consumed by markdown-it's
//     html_block before these rules run, so it stays verbatim — exactly as Kramdown
//     leaves raw-HTML content unprocessed.
export default function kramdownMath(md) {
  // ---- block rule: a standalone $$ … $$ block (may span lines) ----
  md.block.ruler.before('fence', 'kdmath_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false; // indented code
    const src = state.src;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (src.charCodeAt(start) !== 0x24 || src.charCodeAt(start + 1) !== 0x24) return false;

    const closeIdx = src.indexOf('$$', start + 2);
    if (closeIdx === -1) return false;

    // The closing $$ must end its line (nothing but whitespace after it).
    let eol = src.indexOf('\n', closeIdx + 2);
    if (eol === -1) eol = src.length;
    if (src.slice(closeIdx + 2, eol).trim() !== '') return false;

    // Line index of the closing $$.
    let closeLine = startLine;
    for (let i = start; i < closeIdx; i++) if (src.charCodeAt(i) === 0x0a) closeLine++;
    if (closeLine > endLine) return false;

    // before_block_boundary: the next line must be blank or past the block, else this
    // $$…$$ is embedded in a paragraph and is inline, not a block.
    if (closeLine + 1 <= endLine) {
      const nStart = state.bMarks[closeLine + 1] + state.tShift[closeLine + 1];
      const nEnd = state.eMarks[closeLine + 1];
      if (nStart < nEnd) return false;
    }

    if (silent) return true;
    const token = state.push('kdmath_block', '', 0);
    token.block = true;
    token.map = [startLine, closeLine + 1];
    token.content = src.slice(start + 2, closeIdx).trim();
    state.line = closeLine + 1;
    return true;
  });

  // ---- inline rule: $$ … $$ embedded in text ----
  md.inline.ruler.before('escape', 'kdmath_inline', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x24) return false;
    const closeIdx = src.indexOf('$$', pos + 2);
    if (closeIdx === -1) return false;
    if (!silent) {
      const token = state.push('kdmath_inline', '', 0);
      token.markup = '$$';
      token.content = src.slice(pos + 2, closeIdx).trim();
    }
    state.pos = closeIdx + 2;
    return true;
  });

  // Body is inserted RAW (Kramdown does not escape it). $${x}$ interpolation:
  // the leading $$ in the template is a literal $ followed by the ${...} placeholder.
  md.renderer.rules.kdmath_block = (tokens, i) =>
    `<div class="kdmath">$$\n${tokens[i].content}\n$$</div>\n`;
  md.renderer.rules.kdmath_inline = (tokens, i) =>
    `<span class="kdmath">$${tokens[i].content}$</span>`;
}
