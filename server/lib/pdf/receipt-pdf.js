const core = require("../../../shared/invoice-core");
const pdf = require("./base");

const { palette, write, money, formatDate } = pdf;

/** Payment receipt PDF. `payment` includes invoice and customer fields (see payments route). */
async function renderReceiptPdf({ payment, business, assets = {} }) {
  const accent = pdf.safeColor(business.brand_color);
  const currency = payment.currency || "INR";
  const doc = pdf.createDocument({ title: `Receipt ${payment.receipt_number || ""}` });
  const { left, right, width } = pdf.box(doc);
  let y = pdf.box(doc).top;

  let leftY = y;
  if (assets.logo) {
    try {
      doc.image(assets.logo, left, y, { fit: [120, 48] });
      leftY = y + 56;
    } catch (error) {
      leftY = y;
    }
  }
  leftY = write(doc, business.name || "Your business", left, leftY, { font: "Bold", size: 13, color: palette.ink, width: width * 0.6 });
  const address = [business.address, [business.city, business.state, business.postal_code].filter(Boolean).join(", ")]
    .filter((line) => String(line || "").trim())
    .join("\n");
  if (address) leftY = write(doc, address, left, leftY + 2, { size: 8.5, color: palette.muted, width: width * 0.6 });
  if (business.gst_number) leftY = write(doc, `GSTIN: ${business.gst_number}`, left, leftY + 2, { font: "SemiBold", size: 8.5, width: width * 0.6 });

  let rightY = write(doc, "PAYMENT RECEIPT", left + width * 0.5, y, {
    font: "Bold",
    size: 16,
    color: accent,
    width: width * 0.5,
    align: "right",
  });
  [
    ["Receipt no.", payment.receipt_number || "-"],
    ["Payment date", formatDate(payment.payment_date)],
  ].forEach(([label, value]) => {
    rightY = write(doc, `${label}: ${value}`, left + width * 0.5, rightY + 3, { size: 9, color: palette.text, width: width * 0.5, align: "right" });
  });

  y = Math.max(leftY, rightY) + 18;
  doc.save().moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(palette.line).stroke().restore();
  y += 18;

  doc.save().roundedRect(left, y, width, 74, 8).fill(pdf.tint(accent, 0.08)).restore();
  write(doc, "AMOUNT RECEIVED", left + 16, y + 14, { font: "SemiBold", size: 8, color: accent, width: width / 2 });
  write(doc, money(payment.amount, currency), left + 16, y + 28, { font: "Bold", size: 22, color: palette.ink, width: width / 2 });
  write(doc, core.amountInWords(core.toUnits(payment.amount), currency), left + width / 2, y + 22, {
    font: "SemiBold",
    size: 9,
    color: palette.text,
    width: width / 2 - 16,
    align: "right",
  });
  y += 96;

  const rows = [
    ["Received from", [payment.customer_name, payment.customer_company].filter(Boolean).join(", ") || "-"],
    ["Payment method", core.paymentMethodLabel(payment.method)],
    ["Reference", payment.reference || "-"],
    ["Against invoice", `${payment.invoice_number} dated ${formatDate(payment.issue_date)}`],
    ["Invoice total", money(payment.invoice_total, currency)],
    ["Total received to date", money(payment.invoice_paid_total, currency)],
    ["Balance due", money(core.unitsToString(core.toUnits(payment.invoice_total) - core.toUnits(payment.invoice_paid_total)), currency)],
  ];
  if (payment.notes) rows.push(["Notes", payment.notes]);
  rows.forEach(([label, value]) => {
    write(doc, label, left, y, { size: 9, color: palette.muted, width: 160 });
    y = Math.max(y + 14, write(doc, value, left + 170, y, { font: "SemiBold", size: 9, color: palette.ink, width: width - 170 })) + 6;
    doc.save().moveTo(left, y - 3).lineTo(right, y - 3).lineWidth(0.4).strokeColor(palette.line).stroke().restore();
  });
  y += 10;
  if (payment.voided_at) {
    y = write(doc, `This payment was voided on ${formatDate(payment.voided_at)}: ${payment.void_reason}`, left, y, {
      font: "SemiBold",
      size: 9,
      color: palette.danger,
      width,
    });
    y += 10;
  }
  write(
    doc,
    "This receipt acknowledges a payment recorded by the business. It is not a tax invoice.",
    left,
    y,
    { size: 8, color: palette.muted, width }
  );

  if (business.show_signature_block) {
    let sy = y + 40;
    const sx = right - 200;
    sy = write(doc, `For ${business.name || ""}`, sx, sy, { font: "SemiBold", size: 8.5, color: palette.ink, width: 200, align: "right" });
    if (assets.signature) {
      try {
        doc.image(assets.signature, right - 130, sy + 4, { fit: [130, 44], align: "right", valign: "bottom" });
      } catch (error) {
        // Ignore unreadable images.
      }
    }
    sy += 54;
    doc.save().moveTo(right - 150, sy).lineTo(right, sy).lineWidth(0.6).strokeColor(palette.faint).stroke().restore();
    write(doc, business.signatory_title || "Authorised Signatory", sx, sy + 4, { size: 8, color: palette.muted, width: 200, align: "right" });
  }

  if (payment.voided_at) pdf.watermark(doc, "VOID", palette.danger);
  pdf.footer(doc, `Receipt ${payment.receipt_number || ""} · Generated with Invoice Studio`);
  return pdf.toBuffer(doc);
}

module.exports = { renderReceiptPdf };
