/**
 * CSV helpers. Text cells that a spreadsheet would treat as a formula are
 * prefixed with an apostrophe (CSV injection protection).
 */
function csvCell(value, type) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (type !== "money" && type !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(columns, rows, totals) {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  rows.forEach((row) => {
    lines.push(columns.map((column) => csvCell(row[column.key], column.type)).join(","));
  });
  if (totals) {
    lines.push(
      columns
        .map((column, i) => (i === 0 ? "Total" : csvCell(totals[column.key] !== undefined ? totals[column.key] : "", column.type)))
        .join(",")
    );
  }
  // BOM so Excel opens UTF-8 (₹, names in Indian scripts) correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

module.exports = { csvCell, toCsv };
