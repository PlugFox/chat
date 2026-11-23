/**
 * A message table as CSV (RFC 4180) for the clipboard. A cell a spreadsheet
 * would run as a formula (`=`, `+`, `-`, `@`, tab, carriage return) gets a
 * leading `'`: the text comes from the model, and a paste must not compute.
 */
import type { Span } from "../protocol/generated/protocol";

function cell(spans: Span[]): string {
  let text = spans.map((s) => (typeof s === "string" ? s : s.text)).join("");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tableCsv(head: Span[][], rows: Span[][][]): string {
  return [head, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}
