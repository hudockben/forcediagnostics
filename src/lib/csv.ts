// Reads CSV text the way RFC 4180 describes it: fields split by commas, rows
// by CRLF (a bare LF or CR works too), and a field in double quotes may hold
// commas, line breaks and quotes written twice (""). A byte order mark at the
// start is dropped, and so is the line break after the last row. Kept free of
// other imports so the browser can use it.

export class CsvError extends Error {
  constructor(
    message: string,
    // 1-based, counting rows rather than lines (a quoted field can span lines).
    readonly row: number,
  ) {
    super(message);
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  const end = text.length;
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (at >= end) return rows;

  for (;;) {
    // One field, starting at `at`.
    let field: string;
    if (text[at] === '"') {
      field = "";
      let from = at + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote === -1) throw new CsvError("A quoted field never ends: a closing quote is missing.", rows.length + 1);
        field += text.slice(from, quote);
        if (text[quote + 1] === '"') {
          field += '"';
          from = quote + 2;
        } else {
          at = quote + 1;
          break;
        }
      }
      const next = text[at];
      if (at < end && next !== "," && next !== "\r" && next !== "\n") {
        throw new CsvError("Something follows a closing quote before the next comma.", rows.length + 1);
      }
    } else {
      // Unquoted: up to the next comma or line break. A stray quote inside
      // is kept as it is, as spreadsheet programs do.
      let stop = at;
      while (stop < end) {
        const c = text.charCodeAt(stop);
        if (c === 44 /* , */ || c === 13 /* \r */ || c === 10 /* \n */) break;
        stop++;
      }
      field = text.slice(at, stop);
      at = stop;
    }
    row.push(field);

    if (at >= end) {
      rows.push(row);
      return rows;
    }
    if (text[at] === ",") {
      at++;
      // A comma at the very end still means one more (empty) field.
      if (at >= end) {
        row.push("");
        rows.push(row);
        return rows;
      }
      continue;
    }
    // A line break: CRLF, LF or a lone CR.
    at += text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1;
    rows.push(row);
    row = [];
    if (at >= end) return rows;
  }
}
