/**
 * Texto da memória: normalização sem acentos, palavras-chave, radical leve e similaridade lexical
 * (versão de navegador de server/memory/text.ts).
 */

const STOPWORDS = new Set(
  (
    'a o e os as um uma uns umas de do da dos das em no na nos nas num numa por pelo pela pelos pelas ' +
    'para pra pro com sem sob sobre entre ate apos ao aos que se ou mas nem como quando onde qual ' +
    'quais quem cujo cuja isso isto aquilo esse essa esses essas este esta estes estas aquele aquela ' +
    'aqueles aquelas eu tu ele ela nos vos eles elas voce voces me te lhe lhes mim ti si meu minha meus ' +
    'minhas teu tua teus tuas seu sua seus suas nosso nossa nossos nossas dele dela deles delas ja tambem ' +
    'so muito muita muitos muitas mais menos bem foi era ser ter tem tinha ha estao estava ' +
    'vai vou fazer feito the and of to in is are was were be for on at by with it this that an or'
  ).split(/\s+/),
);

export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function keywordTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
}

const SUFFIXES = ['oes', 'aes', 'ais', 'eis', 'ois', 'ao', 'as', 'es', 'os', 'is', 'a', 'e', 'o', 's'];

export function lightStem(token: string): string {
  if (token.length < 6 || /\d/.test(token)) return token;
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
  }
  return token;
}

/** Termos de busca (radicais únicos). */
export function queryTerms(text: string, max = 16): string[] {
  let terms = keywordTokens(text);
  if (terms.length === 0) terms = tokenize(text).filter((t) => t.length > 1 || /\d/.test(t));
  return [...new Set(terms.map(lightStem))].slice(0, max);
}

/**
 * Pontuação 0–1 de quanto `content` responde aos termos (prefixo por palavra, sem acentos).
 * 0 quando nenhum termo aparece.
 */
export function matchScore(terms: string[], content: string): number {
  if (terms.length === 0) return 0;
  const words = tokenize(content);
  if (words.length === 0) return 0;
  let hit = 0;
  for (const t of terms) {
    if (words.some((w) => w.startsWith(t) || (t.length >= 5 && t.startsWith(w) && w.length >= 4))) hit++;
  }
  return hit / terms.length;
}

/** Coeficiente de Dice entre os conjuntos de palavras-chave (0–1). */
export function lexicalSimilarity(a: string, b: string): number {
  const ta = new Set(keywordTokens(a).map(lightStem));
  const tb = new Set(keywordTokens(b).map(lightStem));
  if (ta.size === 0 && tb.size === 0) return normalizeText(a).trim() === normalizeText(b).trim() ? 1 : 0;
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}
