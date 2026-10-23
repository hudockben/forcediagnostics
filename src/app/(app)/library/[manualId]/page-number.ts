// The page a manual's address names (`?page=N`), for the server's first
// render and for the viewer, which follows the address on Back and Forward:
// page 1 when it names none or something that isn't a page number, the
// first or last page when it's out of range.
export function pageFromAddress(page: string | string[] | null | undefined, pageCount: number) {
  const requested = Number(typeof page === "string" ? page : 1);
  return Number.isInteger(requested) ? Math.min(Math.max(requested, 1), pageCount) : 1;
}
