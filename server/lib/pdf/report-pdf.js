const pdf = require("./base");

const { palette, write, plainAmount, formatDate } = pdf;

function formatCell(value, type) {
  if (value === null || value === undefined || value === "") return "-";
  if (type === "money") return plainAmount(value);
  if (type === "date") return formatDate(value);
  if (type === "percent") return `${value}%`;
  return String(value);
}

/** Render a tabular report (same structure as the JSON/CSV report output). */
async function renderReportPdf({ report, business }) {
  const wide = report.columns.length > 6;
  const doc = pdf.createDocument({ title: report.title, layout: wide ? "landscape" : "portrait" });
  const { left, width } = pdf.box(doc);
  const accent = pdf.safeColor(business.brand_color);
  let y = pdf.box(doc).top;

  y = write(doc, report.title, left, y, { font: "Bold", size: 16, color: palette.ink, width });
  const period = report.meta.from || report.meta.to ? `${formatDate(report.meta.from)} – ${formatDate(report.meta.to)}` : "All dates";
  y = write(doc, `${business.name || ""}  ·  ${period}  ·  Amounts in ${report.meta.currency || "INR"}`, left, y + 3, {
    size: 8.5,
    color: palette.muted,
    width,
  });
  if (report.note) y = write(doc, report.note, left, y + 3, { size: 8, color: palette.muted, width });
  y += 14;

  const moneyWidth = 78;
  const columns = report.columns.map((column) => {
    if (column.type === "money") return { label: column.label, width: moneyWidth, align: "right" };
    if (column.type === "number" || column.type === "percent") return { label: column.label, width: 50, align: "right" };
    if (column.type === "date") return { label: column.label, width: 66 };
    return { label: column.label };
  });
  const rows = report.rows.map((row) => ({
    cells: report.columns.map((column) => formatCell(row[column.key], column.type)),
  }));
  if (report.totals) {
    rows.push({
      cells: report.columns.map((column, i) =>
        i === 0 ? "Total" : report.totals[column.key] !== undefined ? formatCell(report.totals[column.key], column.type) : ""
      ),
      style: { font: "SemiBold", fill: palette.soft },
    });
  }
  if (!report.rows.length) {
    write(doc, "No records for the selected filters.", left, y, { size: 9, color: palette.muted, width });
  } else {
    pdf.table(doc, { x: left, y, width, columns, rows, size: 8, accent });
  }
  pdf.footer(doc, `${report.title} · Generated ${formatDate(new Date().toISOString())} with Invoice Studio`);
  return pdf.toBuffer(doc);
}

module.exports = { renderReportPdf };
