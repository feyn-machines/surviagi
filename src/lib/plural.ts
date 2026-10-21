/**
 * English agreement in copy templates: `{n|update bears|updates bear}` becomes the first form when the
 * value of `n` is exactly 1 and the second otherwise. The number itself is still written as `{n}`, so
 * "{n} {n|update bears|updates bear} on it" reads "1 update bears on it" and "3 updates bear on it".
 * Chinese copy has no such tokens. A value may already be formatted ("1,204"); a token whose key has
 * no value is left as it is, so a missing value shows rather than reading as a plural.
 */
export function plural(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (token, key: string, one: string, other: string) => {
    if (!(key in values) || values[key] === undefined) return token;
    return Number(String(values[key]).replace(/[,\s]/g, "")) === 1 ? one : other;
  });
}
