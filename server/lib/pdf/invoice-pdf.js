const core = require("../../../shared/invoice-core");
const pdf = require("./base");

const { palette, write, plainAmount, money, formatDate } = pdf;

function addressLines(party) {
  if (!party) return [];
  const cityLine = [party.city, party.state && party.state_code ? `${party.state} (${party.state_code})` : party.state, party.postal_code]
    .filter(Boolean)
    .join(", ");
  return [party.address, cityLine, party.country].filter((line) => String(line || "").trim());
}

function stateLabel(code) {
  const state = core.stateByCode(code);
  return state ? `${state.name} (${state.code})` : code || "";
}

function documentTitle(invoice) {
  if (invoice.tax_type === "cgst_sgst" || invoice.tax_type === "igst") return "TAX INVOICE";
  return "INVOICE";
}

/**
 * Render an invoice PDF from saved invoice data (see fetchInvoice) and the
 * business settings. Returns a Buffer.
 */
async function renderInvoicePdf({ invoice, business, assets = {} }) {
  const accent = pdf.safeColor(business.brand_color);
  const currency = invoice.currency || "INR";
  const supplier = invoice.supplier || {};
  const customer = invoice.customer;
  const isGst = invoice.tax_type === "cgst_sgst" || invoice.tax_type === "igst";
  const doc = pdf.createDocument({ title: `Invoice ${invoice.invoice_number}` });
  const { left, right, width } = pdf.box(doc);

  // ---- Header: supplier (left) and document details (right) -------------
  let y = pdf.box(doc).top;
  let leftY = y;
  if (assets.logo) {
    try {
      doc.image(assets.logo, left, y, { fit: [130, 54], align: "left", valign: "top" });
      leftY = y + 62;
    } catch (error) {
      leftY = y;
    }
  }
  const leftWidth = width * 0.56;
  leftY = write(doc, supplier.name || business.name || "Your business", left, leftY, {
    font: "Bold",
    size: 14,
    color: palette.ink,
    width: leftWidth,
  });
  leftY += 2;
  addressLines(supplier).forEach((line) => {
    leftY = write(doc, line, left, leftY, { size: 8.5, color: palette.muted, width: leftWidth });
  });
  const ids = [
    supplier.gst_number ? `GSTIN: ${supplier.gst_number}` : "",
    supplier.pan ? `PAN: ${supplier.pan}` : "",
  ].filter(Boolean);
  if (ids.length) leftY = write(doc, ids.join("    "), left, leftY + 2, { font: "SemiBold", size: 8.5, color: palette.text, width: leftWidth });
  const contact = [supplier.phone, supplier.email, supplier.website].filter(Boolean).join("  ·  ");
  if (contact) leftY = write(doc, contact, left, leftY + 1, { size: 8.5, color: palette.muted, width: leftWidth });

  const metaX = left + width * 0.6;
  const metaWidth = right - metaX;
  let rightY = write(doc, documentTitle(invoice), metaX, y, {
    font: "Bold",
    size: 18,
    color: accent,
    width: metaWidth,
    align: "right",
  });
  rightY += 6;
  const meta = [
    ["Invoice no.", invoice.invoice_number],
    ["Invoice date", formatDate(invoice.issue_date)],
    ["Due date", invoice.due_date ? formatDate(invoice.due_date) : "On receipt"],
  ];
  if (isGst && invoice.place_of_supply) meta.push(["Place of supply", stateLabel(invoice.place_of_supply)]);
  if (isGst) meta.push(["Reverse charge", invoice.reverse_charge ? "Yes" : "No"]);
  meta.forEach(([label, value]) => {
    write(doc, label, metaX, rightY, { size: 8.5, color: palette.muted, width: metaWidth * 0.45 });
    rightY = write(doc, value, metaX + metaWidth * 0.45, rightY, {
      font: "SemiBold",
      size: 8.5,
      color: palette.ink,
      width: metaWidth * 0.55,
      align: "right",
    });
    rightY += 2;
  });
  if (invoice.status === "paid") {
    rightY = write(doc, "PAID", metaX, rightY + 2, { font: "Bold", size: 10, color: palette.success, width: metaWidth, align: "right" });
  }

  y = Math.max(leftY, rightY) + 14;
  doc.save().moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(palette.line).stroke().restore();
  y += 12;

  // ---- Parties ------------------------------------------------------------
  const shipping = customer?.shipping_address && customer.shipping_address.trim();
  const colWidth = shipping ? (width - 20) / 2 : width * 0.6;
  const partyBlock = (title, x, startY, lines) => {
    let py = write(doc, title.toUpperCase(), x, startY, { font: "SemiBold", size: 7.5, color: accent, width: colWidth });
    py += 3;
    lines.forEach(([text, style]) => {
      if (!String(text || "").trim()) return;
      py = write(doc, text, x, py, Object.assign({ size: 8.5, color: palette.text, width: colWidth }, style || {}));
      py += 1;
    });
    return py;
  };
  const billLines = customer
    ? [
        [customer.name, { font: "SemiBold", size: 10, color: palette.ink }],
        [customer.company_name],
        ...addressLines(customer).map((line) => [line, { color: palette.muted }]),
        [customer.gst_number ? `GSTIN: ${customer.gst_number}` : "", { font: "SemiBold" }],
        [customer.pan ? `PAN: ${customer.pan}` : ""],
        [[customer.phone, customer.email].filter(Boolean).join("  ·  "), { color: palette.muted }],
      ]
    : [["Customer details not provided", { color: palette.muted }]];
  let partiesEnd = partyBlock("Bill to", left, y, billLines);
  if (shipping) {
    partiesEnd = Math.max(
      partiesEnd,
      partyBlock("Ship to", left + colWidth + 20, y, [
        [customer.name, { font: "SemiBold", size: 10, color: palette.ink }],
        [shipping, { color: palette.muted }],
      ])
    );
  }
  y = partiesEnd + 14;

  // ---- Line items ---------------------------------------------------------
  const hasDiscount = invoice.items.some((item) => core.toUnits(item.discount_amount) > 0);
  const hasTax = invoice.tax_type !== "none";
  const columns = [{ label: "#", width: 28, align: "left" }, { label: "Item / description" }, { label: "Qty", width: 46, align: "right" }];
  columns.push({ label: "Rate", width: 62, align: "right" });
  if (hasDiscount) columns.push({ label: "Discount", width: 54, align: "right" });
  if (hasTax) {
    columns.push({ label: isGst ? "Taxable value" : "Net", width: 66, align: "right" });
    columns.push({ label: isGst ? "GST" : "Tax", width: 58, align: "right" });
  }
  columns.push({ label: `Amount (${currency})`, width: 72, align: "right" });

  const rows = invoice.items.map((item, index) => {
    const qtyText = core.formatQuantity(core.toUnits(item.quantity, core.QTY_SCALE));
    const cells = [
      String(index + 1),
      { text: item.description, sub: item.hsn_sac ? `HSN/SAC: ${item.hsn_sac}` : "" },
      { text: qtyText, sub: item.unit || "" },
      plainAmount(item.unit_price),
    ];
    if (hasDiscount) {
      const discountSub =
        item.discount_type === "percent" && core.toUnits(item.discount_value) > 0
          ? `${core.unitsToPlain(core.toUnits(item.discount_value))}%`
          : "";
      cells.push(core.toUnits(item.discount_amount) > 0 ? { text: plainAmount(item.discount_amount), sub: discountSub } : "-");
    }
    if (hasTax) {
      cells.push(plainAmount(item.taxable_amount));
      cells.push({ text: plainAmount(item.tax_amount), sub: `${core.unitsToPlain(core.toUnits(item.tax_rate))}%` });
    }
    cells.push(plainAmount(item.line_total));
    return { cells };
  });
  y = pdf.table(doc, { x: left, y, width, columns, rows, accent });
  y += 14;

  // ---- Amount in words (left) and totals (right) ------------------------
  const totals = [["Subtotal", money(invoice.subtotal, currency)]];
  if (core.toUnits(invoice.discount_total) > 0) totals.push(["Discount", `− ${money(invoice.discount_total, currency)}`]);
  if (hasTax) totals.push([isGst ? "Taxable amount" : "Net amount", money(invoice.taxable_total, currency)]);
  if (invoice.tax_type === "cgst_sgst") {
    totals.push(["CGST", money(invoice.cgst_total, currency)]);
    totals.push(["SGST", money(invoice.sgst_total, currency)]);
  } else if (invoice.tax_type === "igst") {
    totals.push(["IGST", money(invoice.igst_total, currency)]);
  } else if (invoice.tax_type === "simple") {
    totals.push(["Tax", money(invoice.tax_total, currency)]);
  }
  if (invoice.reverse_charge) totals.push(["GST payable by recipient (reverse charge)", `− ${money(invoice.tax_total, currency)}`]);
  if (core.toUnits(invoice.round_off) !== 0) totals.push(["Round off", money(invoice.round_off, currency)]);

  const totalsWidth = 230;
  const totalsX = right - totalsWidth;
  const totalsHeight = totals.length * 17 + 34 + (core.toUnits(invoice.paid_total) > 0 ? 34 : 0) + 10;
  y = pdf.ensureSpace(doc, y, Math.max(totalsHeight, 70));
  let ty = y;
  totals.forEach(([label, value]) => {
    write(doc, label, totalsX, ty, { size: 8.5, color: palette.muted, width: totalsWidth * 0.62 });
    write(doc, value, totalsX + totalsWidth * 0.5, ty, { size: 8.5, color: palette.ink, width: totalsWidth * 0.5, align: "right" });
    ty += 17;
  });
  doc.save().rect(totalsX, ty, totalsWidth, 28).fill(pdf.tint(accent, 0.1)).restore();
  write(doc, "Total", totalsX + 8, ty + 8, { font: "Bold", size: 10.5, color: palette.ink, width: totalsWidth * 0.4 });
  write(doc, money(invoice.total, currency), totalsX + totalsWidth * 0.35, ty + 7.5, {
    font: "Bold",
    size: 11.5,
    color: palette.ink,
    width: totalsWidth * 0.65 - 8,
    align: "right",
  });
  ty += 34;
  if (core.toUnits(invoice.paid_total) > 0) {
    write(doc, "Amount paid", totalsX, ty, { size: 8.5, color: palette.muted, width: totalsWidth * 0.6 });
    write(doc, money(invoice.paid_total, currency), totalsX + totalsWidth * 0.5, ty, { size: 8.5, color: palette.success, width: totalsWidth * 0.5, align: "right" });
    ty += 17;
    write(doc, "Balance due", totalsX, ty, { font: "SemiBold", size: 9.5, color: palette.ink, width: totalsWidth * 0.6 });
    write(doc, money(invoice.balance_due, currency), totalsX + totalsWidth * 0.5, ty, {
      font: "Bold",
      size: 9.5,
      color: palette.ink,
      width: totalsWidth * 0.5,
      align: "right",
    });
    ty += 17;
  }

  const wordsWidth = totalsX - left - 24;
  let wy = write(doc, "AMOUNT IN WORDS", left, y, { font: "SemiBold", size: 7.5, color: accent, width: wordsWidth });
  wy = write(doc, invoice.amount_in_words, left, wy + 3, { font: "SemiBold", size: 9, color: palette.ink, width: wordsWidth });
  if (invoice.reverse_charge) {
    wy = write(
      doc,
      "Tax is payable on reverse charge basis by the recipient. GST shown is not included in the amount payable.",
      left,
      wy + 6,
      { size: 8, color: palette.muted, width: wordsWidth }
    );
  }
  if (invoice.status === "cancelled") {
    wy = write(doc, `This invoice was cancelled${invoice.cancel_reason ? `: ${invoice.cancel_reason}` : "."}`, left, wy + 6, {
      font: "SemiBold",
      size: 8.5,
      color: palette.danger,
      width: wordsWidth,
    });
  }
  y = Math.max(ty, wy) + 16;

  // ---- Tax summary ------------------------------------------------------
  if (isGst && invoice.tax_summary.length) {
    y = pdf.ensureSpace(doc, y, 70);
    write(doc, "TAX SUMMARY", left, y, { font: "SemiBold", size: 7.5, color: accent, width });
    y += 13;
    const byHsn = invoice.tax_summary.some((row) => row.hsn_sac);
    const summaryColumns = byHsn
      ? [{ label: "HSN/SAC" }, { label: "Rate", width: 50, align: "right" }]
      : [{ label: "GST rate" }];
    summaryColumns.push({ label: "Taxable value", width: 92, align: "right" });
    if (invoice.tax_type === "cgst_sgst") {
      summaryColumns.push({ label: "CGST", width: 84, align: "right" }, { label: "SGST", width: 84, align: "right" });
    } else {
      summaryColumns.push({ label: "IGST", width: 100, align: "right" });
    }
    summaryColumns.push({ label: "Total tax", width: 90, align: "right" });
    const summaryRows = invoice.tax_summary.map((row) => {
      // Half of a 2-decimal rate needs up to 3 decimals (0.25% → 0.125%).
      const half = core.unitsToPlain(core.toUnits(row.rate) * 5, 3);
      const cells = [];
      if (byHsn) cells.push(row.hsn_sac || "-");
      cells.push(`${core.unitsToPlain(core.toUnits(row.rate))}%`, plainAmount(row.taxable));
      if (invoice.tax_type === "cgst_sgst") {
        cells.push({ text: plainAmount(row.cgst), sub: `@ ${half}%` }, { text: plainAmount(row.sgst), sub: `@ ${half}%` });
      } else {
        cells.push(plainAmount(row.igst));
      }
      cells.push(plainAmount(row.tax));
      return { cells };
    });
    const totalCells = byHsn ? ["Total", ""] : ["Total"];
    totalCells.push(plainAmount(invoice.taxable_total));
    if (invoice.tax_type === "cgst_sgst") totalCells.push(plainAmount(invoice.cgst_total), plainAmount(invoice.sgst_total));
    else totalCells.push(plainAmount(invoice.igst_total));
    totalCells.push(plainAmount(invoice.tax_total));
    summaryRows.push({ cells: totalCells, style: { font: "SemiBold", fill: palette.soft } });
    y = pdf.table(doc, { x: left, y, width, columns: summaryColumns, rows: summaryRows, size: 8, accent, headerFill: palette.soft });
    y += 16;
  }

  // ---- Payment details: bank, instructions, UPI QR -----------------------
  const bankLines = [
    business.bank_account_name ? ["Account name", business.bank_account_name] : null,
    business.bank_name ? ["Bank", business.bank_name] : null,
    business.bank_account_number ? ["Account no.", business.bank_account_number] : null,
    business.bank_ifsc ? ["IFSC", business.bank_ifsc] : null,
    business.bank_branch ? ["Branch", business.bank_branch] : null,
  ].filter(Boolean);
  const balanceUnits = core.toUnits(invoice.balance_due);
  const showQr =
    business.show_upi_qr && business.upi_id && currency === "INR" && balanceUnits > 0 && invoice.status !== "cancelled";
  const extraBank = String(business.bank_details || "").trim();
  const instructions = String(invoice.payment_instructions || "").trim();

  if (bankLines.length || extraBank || instructions || showQr || business.upi_id) {
    const qrSize = 92;
    const infoWidth = showQr ? width - qrSize - 40 : width;
    const estimate =
      Math.max(
        bankLines.length * 13 + (extraBank ? pdf.textHeight(doc, extraBank, { size: 8.5, width: infoWidth }) : 0) +
          (instructions ? pdf.textHeight(doc, instructions, { size: 8.5, width: infoWidth }) + 16 : 0),
        showQr ? qrSize + 40 : 0
      ) + 24;
    y = pdf.ensureSpace(doc, y, Math.min(estimate, 300));
    const start = y;
    let py = write(doc, "PAYMENT DETAILS", left, y, { font: "SemiBold", size: 7.5, color: accent, width: infoWidth });
    py += 4;
    bankLines.forEach(([label, value]) => {
      write(doc, label, left, py, { size: 8.5, color: palette.muted, width: 90 });
      py = write(doc, value, left + 90, py, { font: "SemiBold", size: 8.5, color: palette.ink, width: infoWidth - 90 });
      py += 2;
    });
    if (business.upi_id) {
      write(doc, "UPI ID", left, py, { size: 8.5, color: palette.muted, width: 90 });
      py = write(doc, business.upi_id, left + 90, py, { font: "SemiBold", size: 8.5, color: palette.ink, width: infoWidth - 90 }) + 2;
    }
    if (extraBank) py = write(doc, extraBank, left, py + 2, { size: 8.5, color: palette.text, width: infoWidth }) + 2;
    if (instructions) {
      py = write(doc, "Payment instructions", left, py + 6, { font: "SemiBold", size: 8.5, color: palette.ink, width: infoWidth });
      py = write(doc, instructions, left, py + 2, { size: 8.5, color: palette.text, width: infoWidth });
    }
    let qy = start;
    if (showQr) {
      const qx = right - qrSize;
      const link = core.upiLink({
        upiId: business.upi_id,
        payeeName: supplier.name || business.name,
        amountUnits: balanceUnits,
        note: invoice.invoice_number,
      });
      pdf.drawQr(doc, link, qx, start + 4, qrSize);
      qy = write(doc, "Scan to pay with any UPI app", qx - 30, start + qrSize + 10, {
        font: "SemiBold",
        size: 7.5,
        color: palette.ink,
        width: qrSize + 30,
        align: "center",
      });
      qy = write(doc, `${money(invoice.balance_due, currency)} to ${business.upi_id}`, qx - 30, qy + 1, {
        size: 7,
        color: palette.muted,
        width: qrSize + 30,
        align: "center",
      });
    }
    y = Math.max(py, qy) + 16;
  }

  // ---- Notes and terms ------------------------------------------------------
  [
    ["Notes", invoice.notes],
    ["Terms and conditions", invoice.terms],
  ].forEach(([title, body]) => {
    const textBody = String(body || "").trim();
    if (!textBody) return;
    y = pdf.ensureSpace(doc, y, Math.min(pdf.textHeight(doc, textBody, { size: 8.5, width }) + 24, 200));
    y = write(doc, title.toUpperCase(), left, y, { font: "SemiBold", size: 7.5, color: accent, width });
    y = write(doc, textBody, left, y + 3, { size: 8.5, color: palette.text, width }) + 14;
  });

  // ---- Signature --------------------------------------------------------
  if (business.show_signature_block) {
    const sigWidth = 200;
    const sx = right - sigWidth;
    y = pdf.ensureSpace(doc, y, 110);
    let sy = write(doc, `For ${supplier.name || business.name || ""}`, sx, y, {
      font: "SemiBold",
      size: 8.5,
      color: palette.ink,
      width: sigWidth,
      align: "right",
    });
    const imageTop = sy + 4;
    let imageBottom = imageTop + 44;
    if (assets.stamp) {
      try {
        doc.image(assets.stamp, sx, imageTop - 6, { fit: [64, 64], align: "center", valign: "center" });
        imageBottom = Math.max(imageBottom, imageTop + 58);
      } catch (error) {
        // Ignore unreadable images; the PDF should still be produced.
      }
    }
    if (assets.signature) {
      try {
        doc.image(assets.signature, right - 130, imageTop, { fit: [130, 44], align: "right", valign: "bottom" });
      } catch (error) {
        // Ignore unreadable images.
      }
    }
    sy = imageBottom + 4;
    doc.save().moveTo(right - 150, sy).lineTo(right, sy).lineWidth(0.6).strokeColor(palette.faint).stroke().restore();
    sy += 4;
    if (business.signatory_name) {
      sy = write(doc, business.signatory_name, sx, sy, { font: "SemiBold", size: 8.5, color: palette.ink, width: sigWidth, align: "right" });
    }
    write(doc, business.signatory_title || "Authorised Signatory", sx, sy, {
      size: 8,
      color: palette.muted,
      width: sigWidth,
      align: "right",
    });
  }

  if (invoice.status === "cancelled") pdf.watermark(doc, "CANCELLED", palette.danger);
  else if (invoice.status === "draft") pdf.watermark(doc, "DRAFT", palette.muted);
  pdf.footer(doc, `${invoice.invoice_number} · Generated with Invoice Studio`);
  return pdf.toBuffer(doc);
}

module.exports = { renderInvoicePdf };
