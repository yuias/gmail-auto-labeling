// RFC 4180 line encoding. A field needs quoting when it contains a comma, a
// double quote, or a line break; embedded quotes double up.
export function toCsvLine(fields: unknown[]): string {
  return fields
    .map((field) => {
      if (field === null || field === undefined) return "";
      const text = String(field);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(",");
}
