/**
 * Rough input token proxy: 1 non-CJK code unit ≈ 0.3 tok, 1 CJK (Han/Hiragana/Katakana/Hangul block) ≈ 0.6 tok.
 * Not equivalent to tiktoken; use for alternate display / JSONL comparison.
 */
export interface CharTokenHeuristicResult {
  enChars: number;
  cjkChars: number;
  inputTokensApprox: number;
}

/** CJK Unified + ext A, Hiragana/Katakana, Hangul syllables. */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af)
  );
}

export function countCharTokenHeuristic(text: string): CharTokenHeuristicResult {
  let enChars = 0;
  let cjkChars = 0;
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    if (isCjkCodePoint(cp)) {
      cjkChars += 1;
    } else {
      enChars += 1;
    }
  }
  const inputTokensApprox = Math.round(enChars * 0.3 + cjkChars * 0.6);
  return { enChars, cjkChars, inputTokensApprox };
}
