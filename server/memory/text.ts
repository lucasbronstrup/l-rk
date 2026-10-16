/**
 * Utilidades de texto da memória: normalização sem acentos, tokenização,
 * montagem segura de consultas FTS5 e similaridade lexical (deduplicação).
 */

/** Palavras muito frequentes (PT/EN) que não ajudam na busca. "não" fica de fora: muda o sentido. */
const STOPWORDS = new Set(
  (
    'a o e os as um uma uns umas de do da dos das em no na nos nas num numa por pelo pela pelos pelas ' +
    'para pra pro com sem sob sobre entre ate apos ao aos a as que se ou mas nem como quando onde qual ' +
    'quais quem cujo cuja isso isto aquilo esse essa esses essas este esta estes estas aquele aquela ' +
    'aqueles aquelas eu tu ele ela nos vos eles elas voce voces me te lhe lhes mim ti si meu minha meus ' +
    'minhas teu tua teus tuas seu sua seus suas nosso nossa nossos nossas dele dela deles delas ja tambem ' +
    'so muito muita muitos muitas mais menos bem foi era ser ter tem tinha ha esta estao estava ' +
    'vai vou fazer feito the and of to in is are was were be for on at by with it this that an or'
  ).split(/\s+/),
);

/** Minúsculas, sem acentos/diacríticos. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Tokens (letras/dígitos) normalizados, na ordem em que aparecem. */
export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Tokens significativos: sem stopwords e sem letras isoladas (dígitos isolados ficam). */
export function keywordTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
}

/** Terminações flexionais comuns (já sem acento), da mais longa para a mais curta. */
const SUFFIXES = ['oes', 'aes', 'ais', 'eis', 'ois', 'ao', 'as', 'es', 'os', 'is', 'a', 'e', 'o', 's'];

/**
 * Radical leve para busca por prefixo: remove uma terminação de plural/gênero de palavras longas,
 * para que "reunião" encontre "reuniões" e "memória" encontre "memórias".
 */
export function lightStem(token: string): string {
  if (token.length < 6 || /\d/.test(token)) return token;
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
  }
  return token;
}

/**
 * Converte texto livre numa consulta FTS5 segura: cada termo (radical) entre aspas, sem operadores,
 * com prefixo `*`, unidos por OR. Retorna null quando não sobra nenhum termo.
 */
export function buildFtsQuery(text: string, maxTerms = 16): string | null {
  let terms = keywordTokens(text);
  if (terms.length === 0) terms = tokenize(text).filter((t) => t.length > 1 || /\d/.test(t));
  const unique = [...new Set(terms.map(lightStem))].slice(0, maxTerms);
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

/** Coeficiente de Dice entre os conjuntos de palavras-chave (0–1). */
export function lexicalSimilarity(a: string, b: string): number {
  const ta = new Set(keywordTokens(a));
  const tb = new Set(keywordTokens(b));
  if (ta.size === 0 && tb.size === 0) return normalizeText(a).trim() === normalizeText(b).trim() ? 1 : 0;
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

/**
 * Termos que identificam algo específico: nomes próprios (palavras capitalizadas fora do início
 * de frase) e números. Normalizados como em `tokenize`.
 */
export function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.match(/[\p{L}\p{N}]+|[.!?]+/gu) ?? [];
  let sentenceStart = true;
  for (const word of words) {
    if (/^[.!?]+$/.test(word)) {
      sentenceStart = true;
      continue;
    }
    if (/\p{N}/u.test(word) || (!sentenceStart && /^\p{Lu}/u.test(word))) out.add(normalizeText(word));
    sentenceStart = false;
  }
  return out;
}

/** O texto antigo cita nomes/números que o novo não menciona (ex.: outro irmão, outra data)? */
export function hasConflictingSpecifics(previous: string, next: string): boolean {
  const nextTokens = new Set(tokenize(next));
  for (const token of distinctiveTokens(previous)) if (!nextTokens.has(token)) return true;
  return false;
}

/** Corta o texto em `max` caracteres, preferindo terminar numa palavra inteira. */
export function truncateText(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}
