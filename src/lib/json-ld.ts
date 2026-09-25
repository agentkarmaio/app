/**
 * Serialize structured data for a `dangerouslySetInnerHTML` <script> body.
 *
 * `JSON.stringify` alone is not enough there: profile descriptions and names
 * come from wallet-signed claims and registry metadata, and a value containing
 * `</script>` would close the tag early and turn the rest of the value into
 * markup. Escaping `<` is what makes the output inert.
 */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
