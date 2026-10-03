// Unicode string rules of the bank format (contract §7): lengths are code
// points of the NFC form, and a fixed set of characters is forbidden in every
// limited string.

export function nfc(s: string): string {
  return s.normalize('NFC');
}

/** Length in code points after NFC normalization; not UTF-16 units, not bytes. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of nfc(s)) n++;
  return n;
}

// U+0000–U+001F, U+007F, U+2028, U+2029.
const FORBIDDEN_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

export function hasForbiddenChars(s: string): boolean {
  return FORBIDDEN_RE.test(s);
}

/** True when the string starts or ends with whitespace (JS `\s`, Unicode-aware). */
export function hasEdgeWhitespace(s: string): boolean {
  return s !== s.trim();
}

/**
 * Compares two strings by code points. Plain `<` compares UTF-16 units, which
 * orders U+E000–U+FFFF after astral characters; code point order does not.
 */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}
