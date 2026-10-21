/** One JSON-LD block. `<` is escaped so a string in the data cannot close the script element. */
export function JsonLd({ data }: { data: object | object[] | null }) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
