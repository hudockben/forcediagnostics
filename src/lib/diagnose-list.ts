import { sql, type AnyColumn, type SQL } from "drizzle-orm";

import { containsPattern, listSearchWords } from "@/lib/diagnose-list-rules";

// The condition a search of the Diagnose list adds (see listConversations in
// src/lib/diagnose.ts): every word somewhere in the fields, any case. The
// fields are joined with spaces, so a word (which never has one) can't match
// across two of them. Undefined, so no condition at all, for an empty search.
export function listSearchCondition(query: string, fields: AnyColumn[]): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ', ${sql.join(fields, sql`, `)})`;
  const patterns = sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  );
  return sql`${text} ilike all (array[${patterns}]::text[])`;
}
