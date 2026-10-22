const cjkRun = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
// Function words carry no retrieval signal and would otherwise let an unrelated
// question clear the score threshold on "is"/"the" alone.
const stopwords = new Set("a an the is are was were be been being of for to in on at and or it its this that these those with by from as do does did".split(" "));
export function queryTokens(query: string): { terms: string[]; bigrams: string[] } {
  const terms = new Set<string>(), bigrams = new Set<string>();
  // Separate scripts first, including adjacent text such as Refund2026.
  for (const match of query.toLowerCase().matchAll(cjkRun)) {
    const chars = [...match[0]];
    for (let i = 0; i + 1 < chars.length; i++) { const pair = chars[i] + chars[i + 1]; terms.add(pair); bigrams.add(pair); }
    if (chars.length <= 3) terms.add(match[0]);
  }
  const words = (query.toLowerCase().replace(cjkRun, " ").match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(word => !stopwords.has(word));
  for (const term of words) terms.add(term);
  // Adjacent word pairs give the bounded-overlap fallback the same signal for
  // space-delimited scripts that character pairs give for CJK.
  for (let i = 0; i + 1 < words.length; i++) bigrams.add(`${words[i]} ${words[i + 1]}`);
  return { terms: [...terms].slice(0, 30), bigrams: [...bigrams].slice(0, 30) };
}

export const hasUsableTokens = (query: string) => queryTokens(query).terms.some(term => [...term].length >= 2);
