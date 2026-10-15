const path = require("path");
const PDFDocument = require("pdfkit");
const qrcode = require("qrcode-generator");
const core = require("../../../shared/invoice-core");

const FONT_DIR = path.join(__dirname, "../../assets/fonts");

const palette = {
  ink: "#111827",
  text: "#374151",
  muted: "#6b7280",
  faint: "#9ca3af",
  line: "#e5e7eb",
  soft: "#f8fafc",
  danger: "#b91c1c",
  success: "#047857",
};

const amountFormatter = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Plain amount without currency symbol ("1,23,456.00") for dense table cells. */
function plainAmount(value) {
  return amountFormatter.format(core.toUnits(value) / 100);
}

function money(value, currency) {
  return core.formatAmount(value, currency);
}

function formatDate(iso) {
  if (!iso) return "-";
  const text = typeof iso === "string" ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  const [y, m, d] = text.split("-").map(Number);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${String(d).padStart(2, "0")} ${month} ${y}`;
}

/** Mix a hex colour with white; amount 0..1 is the share of the original colour. */
function tint(hex, amount) {
  const value = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#2563eb";
  const channels = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  const mixed = channels.map((c) => Math.round(255 - (255 - c) * amount));
  return "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("");
}

function safeColor(hex) {
  return /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#2563eb";
}

function createDocument({ title, layout = "portrait" }) {
  const doc = new PDFDocument({
    size: "A4",
    layout,
    margins: { top: 40, bottom: 52, left: 40, right: 40 },
    bufferPages: true,
    info: { Title: title, Creator: "Invoice Studio", Producer: "Invoice Studio" },
  });
  doc.registerFont("Regular", path.join(FONT_DIR, "Inter_400Regular.ttf"));
  doc.registerFont("SemiBold", path.join(FONT_DIR, "Inter_600SemiBold.ttf"));
  doc.registerFont("Bold", path.join(FONT_DIR, "Inter_700Bold.ttf"));
  doc.font("Regular").fontSize(9).fillColor(palette.text);
  return doc;
}

function box(doc) {
  const { margins } = doc.page;
  return {
    left: margins.left,
    right: doc.page.width - margins.right,
    top: margins.top,
    bottom: doc.page.height - margins.bottom,
    width: doc.page.width - margins.left - margins.right,
  };
}

/** Start a new page when `needed` points do not fit below y. Returns the y to continue at. */
function ensureSpace(doc, y, needed, onNewPage) {
  if (y + needed <= box(doc).bottom) return y;
  doc.addPage();
  const top = box(doc).top;
  return onNewPage ? onNewPage(top) : top;
}

function textHeight(doc, text, { font = "Regular", size = 9, width }) {
  doc.font(font).fontSize(size);
  return doc.heightOfString(String(text ?? ""), { width, lineGap: 1 });
}

function write(doc, text, x, y, { font = "Regular", size = 9, color = palette.text, width, align = "left", lineGap = 1 } = {}) {
  doc.font(font).fontSize(size).fillColor(color);
  doc.text(String(text ?? ""), x, y, { width, align, lineGap, lineBreak: width !== undefined });
  return doc.y;
}

/**
 * Draw a table with wrapping cells and automatic page breaks (the header is
 * repeated on each new page).
 * columns: [{ label, width?, align? }] - one column may omit width to take the rest.
 * rows: [{ cells: [string | { text, sub }], style?: { font, fill, color } }]
 */
function table(doc, { x, y, width, columns, rows, size = 8.5, accent = "#2563eb", headerFill, padX = 5, padY = 5 }) {
  const fixed = columns.reduce((sum, col) => sum + (col.width || 0), 0);
  const flexCount = columns.filter((col) => !col.width).length || 1;
  const widths = columns.map((col) => col.width || Math.max((width - fixed) / flexCount, 40));
  const fill = headerFill || tint(accent, 0.1);

  const drawHeader = (top) => {
    const labelHeight = Math.max(
      ...columns.map((col, i) => textHeight(doc, col.label, { font: "SemiBold", size: size - 0.5, width: widths[i] - padX * 2 }))
    );
    const height = labelHeight + padY * 2;
    doc.save().rect(x, top, width, height).fill(fill).restore();
    doc.save().moveTo(x, top).lineTo(x + width, top).lineWidth(1.2).strokeColor(accent).stroke().restore();
    let cx = x;
    columns.forEach((col, i) => {
      write(doc, col.label, cx + padX, top + padY, {
        font: "SemiBold",
        size: size - 0.5,
        color: palette.ink,
        width: widths[i] - padX * 2,
        align: col.align || "left",
      });
      cx += widths[i];
    });
    return top + height;
  };

  let cursor = drawHeader(y);
  rows.forEach((row) => {
    const style = row.style || {};
    const font = style.font || "Regular";
    const heights = row.cells.map((cell, i) => {
      const cellWidth = widths[i] - padX * 2;
      const main = typeof cell === "object" && cell !== null ? cell.text : cell;
      let h = textHeight(doc, main, { font, size, width: cellWidth });
      if (cell && typeof cell === "object" && cell.sub) h += textHeight(doc, cell.sub, { size: size - 1.5, width: cellWidth }) + 1;
      return h;
    });
    const rowHeight = Math.max(...heights, size) + padY * 2;
    cursor = ensureSpace(doc, cursor, rowHeight, (top) => drawHeader(top));
    if (style.fill) doc.save().rect(x, cursor, width, rowHeight).fill(style.fill).restore();
    let cx = x;
    row.cells.forEach((cell, i) => {
      const cellWidth = widths[i] - padX * 2;
      const align = columns[i].align || "left";
      const main = typeof cell === "object" && cell !== null ? cell.text : cell;
      const after = write(doc, main, cx + padX, cursor + padY, {
        font,
        size,
        color: style.color || palette.ink,
        width: cellWidth,
        align,
      });
      if (cell && typeof cell === "object" && cell.sub) {
        write(doc, cell.sub, cx + padX, after + 1, { size: size - 1.5, color: palette.muted, width: cellWidth, align });
      }
      cx += widths[i];
    });
    cursor += rowHeight;
    doc.save().moveTo(x, cursor).lineTo(x + width, cursor).lineWidth(0.6).strokeColor(palette.line).stroke().restore();
  });
  return cursor;
}

/** Draw a QR code as vector squares (crisp at any zoom). */
function drawQr(doc, text, x, y, size) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / count;
  doc.save().rect(x - 4, y - 4, size + 8, size + 8).fill("#ffffff");
  doc.fillColor("#000000");
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) doc.rect(x + c * cell, y + r * cell, cell + 0.05, cell + 0.05);
    }
  }
  doc.fill();
  doc.restore();
}

/** SVG markup for a QR code (used on the web invoice view). */
function qrSvg(text, { size = 160 } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const dim = count + margin * 2;
  let pathData = "";
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (qr.isDark(r, c)) pathData += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${pathData}" fill="#000"/></svg>`;
}

function watermark(doc, text, color) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const cx = doc.page.width / 2;
    const cy = doc.page.height / 2;
    doc.save();
    doc.rotate(-30, { origin: [cx, cy] });
    doc.font("Bold").fontSize(84).fillColor(color).fillOpacity(0.08);
    doc.text(text, cx - 300, cy - 50, { width: 600, align: "center", lineBreak: false });
    doc.restore();
  }
}

/** Footer with page numbers on every page. Call once all content is written. */
function footer(doc, leftText) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // Allow writing inside the bottom margin without a page break.
    const y = doc.page.height - 34;
    const { left, width } = box(doc);
    doc.save().moveTo(left, y - 8).lineTo(left + width, y - 8).lineWidth(0.5).strokeColor(palette.line).stroke().restore();
    write(doc, leftText, left, y, { size: 7.5, color: palette.faint, width: width / 2 });
    write(doc, `Page ${i - range.start + 1} of ${range.count}`, left + width / 2, y, {
      size: 7.5,
      color: palette.faint,
      width: width / 2,
      align: "right",
    });
    doc.page.margins.bottom = bottom;
  }
}

/** Collect a PDFKit document into a Buffer. */
function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

module.exports = {
  palette,
  plainAmount,
  money,
  formatDate,
  tint,
  safeColor,
  createDocument,
  box,
  ensureSpace,
  textHeight,
  write,
  table,
  drawQr,
  qrSvg,
  watermark,
  footer,
  toBuffer,
};
