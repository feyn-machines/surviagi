/**
 * CSV for a spreadsheet (RFC 4180): UTF-8 byte-order mark, CRLF line ends, quotes around a cell that
 * needs them. A cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return would be run as a
 * formula by a spreadsheet, and display names come from outside, so such a cell gets a leading `'`.
 * No imports: the unit tests load this source directly.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csv(rows: string[][]): string {
  return `﻿${rows.map((row) => `${row.map(cell).join(",")}\r\n`).join("")}`;
}
