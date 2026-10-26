// The Diagnose list's search and pages, and Home's greeting: the pure rules
// (src/lib/diagnose-list-rules.ts, src/lib/diagnose-list.ts,
// src/lib/greeting.ts). The database side is in tests/diagnose.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";

import { listSearchCondition } from "../src/lib/diagnose-list";
import {
  LIST_PAGE_SIZE,
  MAX_LIST_QUERY_LENGTH,
  cleanListQuery,
  containsPattern,
  listHref,
  listPage,
  listSearchWords,
  pageItems,
  parsePage,
} from "../src/lib/diagnose-list-rules";
import { firstName, greetingFor } from "../src/lib/greeting";

describe("the list's search", () => {
  test("the search goes in the address with one space between words, cut to the box's length", () => {
    assert.equal(cleanListQuery("  coil \t  pack\n"), "coil pack");
    assert.equal(cleanListQuery(""), "");
    assert.equal(cleanListQuery("a\u0000b"), "ab");
    assert.equal(cleanListQuery("x".repeat(300)).length, MAX_LIST_QUERY_LENGTH);
    // Cut where a space falls: no space left at the end.
    assert.equal(cleanListQuery(`${"x".repeat(MAX_LIST_QUERY_LENGTH - 1)} y`), "x".repeat(MAX_LIST_QUERY_LENGTH - 1));
    // Never half an emoji.
    assert.equal(cleanListQuery(`${"x".repeat(MAX_LIST_QUERY_LENGTH - 1)}🔧`), "x".repeat(MAX_LIST_QUERY_LENGTH - 1));
    // Cleaning what's already clean changes nothing (the box compares them).
    for (const query of ["coil pack", "Z19VDE99AM", "  mike  RZR "]) assert.equal(cleanListQuery(cleanListQuery(query)), cleanListQuery(query));
  });

  test("words: lower case, each once, without punctuation round them, in the order typed", () => {
    assert.deepEqual(listSearchWords("RZR  misfire, Mike"), ["rzr", "misfire", "mike"]);
    assert.deepEqual(listSearchWords('"Coil" coil COIL'), ["coil"]);
    // Inner punctuation stays: model numbers, VIN parts, "won't".
    assert.deepEqual(listSearchWords("won't start (XP-1000)"), ["won't", "start", "xp-1000"]);
    // A dash between unit and complaint isn't a word.
    assert.deepEqual(listSearchWords("2019 RZR — misfire - P0300"), ["2019", "rzr", "misfire", "p0300"]);
    assert.deepEqual(listSearchWords("  ——  "), []);
    assert.deepEqual(listSearchWords(""), []);
    // Accented letters count as letters.
    assert.deepEqual(listSearchWords("Zoë."), ["zoë"]);
    // At most eight words.
    assert.equal(listSearchWords("a b c d e f g h i j").length, 8);
  });

  test("LIKE patterns take %, _ and backslashes as typed", () => {
    assert.equal(containsPattern("coil"), "%coil%");
    assert.equal(containsPattern("50%"), "%50\\%%");
    assert.equal(containsPattern("a_b"), "%a\\_b%");
    assert.equal(containsPattern("a\\b"), "%a\\\\b%");
  });

  const table = pgTable("t", { title: text("title"), unit: text("unit"), vin: text("vin") });
  const dialect = new PgDialect();

  test("the condition: every word somewhere in the fields joined with spaces, any case", () => {
    const condition = listSearchCondition("Winch  pull", [table.title, table.unit, table.vin]);
    assert.ok(condition);
    const query = dialect.sqlToQuery(condition);
    assert.equal(query.sql, `concat_ws(' ', "t"."title", "t"."unit", "t"."vin") ilike all (array[$1, $2]::text[])`);
    assert.deepEqual(query.params, ["%winch%", "%pull%"]);
    // The words go as parameters, never into the SQL.
    const sneaky = dialect.sqlToQuery(listSearchCondition("o'neil'); drop table t; --", [table.title])!);
    assert.equal(sneaky.sql, `concat_ws(' ', "t"."title") ilike all (array[$1, $2, $3, $4]::text[])`);
    assert.deepEqual(sneaky.params, ["%o'neil%", "%drop%", "%table%", "%t%"]);
  });

  test("no condition for an empty search, or one with no words", () => {
    assert.equal(listSearchCondition("", [table.title]), undefined);
    assert.equal(listSearchCondition("  —  ", [table.title]), undefined);
  });
});

describe("the list's pages", () => {
  test("eight to a page", () => {
    assert.equal(LIST_PAGE_SIZE, 8);
  });

  test("?page= is a whole number from 1; anything else is page 1", () => {
    assert.equal(parsePage(undefined), 1);
    assert.equal(parsePage(""), 1);
    assert.equal(parsePage("2"), 2);
    assert.equal(parsePage(" 3 "), 3);
    assert.equal(parsePage(["4", "5"]), 4);
    for (const bad of ["0", "-1", "1.5", "2e3", "abc", "0x10"]) assert.equal(parsePage(bad), 1, bad);
    assert.equal(parsePage("99999999999999999999"), 1_000_000);
  });

  test("which rows a page holds: 9–16 of 37", () => {
    assert.deepEqual(listPage(37, 2), { page: 2, pages: 5, offset: 8, from: 9, to: 16 });
    assert.deepEqual(listPage(37, 5), { page: 5, pages: 5, offset: 32, from: 33, to: 37 });
    assert.deepEqual(listPage(8, 1), { page: 1, pages: 1, offset: 0, from: 1, to: 8 });
    assert.deepEqual(listPage(9, 2), { page: 2, pages: 2, offset: 8, from: 9, to: 9 });
  });

  test("a page past the end shows the last page; none shows page 1 of 1, empty", () => {
    assert.deepEqual(listPage(37, 99), { page: 5, pages: 5, offset: 32, from: 33, to: 37 });
    assert.deepEqual(listPage(0, 3), { page: 1, pages: 1, offset: 0, from: 0, to: 0 });
    assert.deepEqual(listPage(5, 0), { page: 1, pages: 1, offset: 0, from: 1, to: 5 });
    assert.deepEqual(listPage(5, Number.NaN), listPage(5, 1));
    assert.deepEqual(listPage(20, 2, 10), { page: 2, pages: 2, offset: 10, from: 11, to: 20 });
  });

  test("page numbers: first, last and those round the current one, with gaps", () => {
    assert.deepEqual(pageItems(1, 1), [1]);
    assert.deepEqual(pageItems(1, 2), [1, 2]);
    assert.deepEqual(pageItems(5, 10), [1, null, 4, 5, 6, null, 10]);
    assert.deepEqual(pageItems(1, 10), [1, 2, null, 10]);
    assert.deepEqual(pageItems(10, 10), [1, null, 9, 10]);
    // A gap of one page shows the page.
    assert.deepEqual(pageItems(4, 10), [1, 2, 3, 4, 5, null, 10]);
    assert.deepEqual(pageItems(3, 5), [1, 2, 3, 4, 5]);
    // Compact (on a phone): just the current one between first and last.
    assert.deepEqual(pageItems(5, 10, 0), [1, null, 5, null, 10]);
    assert.deepEqual(pageItems(3, 10, 0), [1, 2, 3, null, 10]);
    assert.deepEqual(pageItems(1, 5, 0), [1, null, 5]);
    for (let pages = 1; pages <= 12; pages++) {
      for (let page = 1; page <= pages; page++) {
        const numbers = pageItems(page, pages).filter((item) => item !== null);
        assert.ok(numbers.includes(page) && numbers[0] === 1 && numbers.at(-1) === pages, `${page} of ${pages}`);
        assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
        assert.equal(new Set(numbers).size, numbers.length);
      }
    }
  });

  test("addresses keep the search and the page; the plain list is /diagnose", () => {
    assert.equal(listHref(""), "/diagnose");
    assert.equal(listHref("", 1), "/diagnose");
    assert.equal(listHref("", 2), "/diagnose?page=2");
    assert.equal(listHref("coil pack"), "/diagnose?q=coil+pack");
    assert.equal(listHref("coil pack", 3), "/diagnose?q=coil+pack&page=3");
    assert.equal(listHref("50% & more"), "/diagnose?q=50%25+%26+more");
    assert.equal(new URL(listHref("coil pack", 3), "https://x.test").searchParams.get("q"), "coil pack");
  });
});

describe("Home's greeting", () => {
  test("by the hour on the viewer's clock", () => {
    assert.equal(greetingFor(4), "Good morning");
    assert.equal(greetingFor(11), "Good morning");
    assert.equal(greetingFor(12), "Good afternoon");
    assert.equal(greetingFor(16), "Good afternoon");
    assert.equal(greetingFor(17), "Good evening");
    assert.equal(greetingFor(23), "Good evening");
    assert.equal(greetingFor(0), "Good evening");
    assert.equal(greetingFor(3), "Good evening");
  });

  test("first names", () => {
    assert.equal(firstName("Mike Tech"), "Mike");
    assert.equal(firstName("  Bea  Admin "), "Bea");
    assert.equal(firstName("Lou"), "Lou");
    assert.equal(firstName(""), "");
  });
});
