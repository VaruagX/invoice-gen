const core = require("../../shared/invoice-core");
const { withTransaction } = require("../db");
const { HttpError, badRequest } = require("./http");
const { logActivity } = require("./activity");
const { rules } = require("./validate");
const { allocateNumber, refreshPaymentState } = require("./invoices");

const METHODS = core.PAYMENT_METHODS.map((method) => method.value);

function validatePayment(body, { today, balanceUnits, currency }) {
  const errors = [];
  let amount = 0;
  try {
    amount = core.parseMoney(body.amount, { label: "Amount", field: "amount", min: 1, minMessage: "Amount must be greater than zero." });
  } catch (error) {
    errors.push({ field: "amount", message: error.message });
  }
  if (amount > balanceUnits) {
    errors.push({
      field: "amount",
      message: `Amount is more than the balance due of ${core.formatMoney(balanceUnits, currency)}.`,
    });
  }
  const date = rules.date({ required: true })(body.payment_date, "Payment date");
  if (date.error) errors.push({ field: "payment_date", message: date.error });
  else if (date.value > today) errors.push({ field: "payment_date", message: "Payment date cannot be in the future." });
  const method = METHODS.includes(body.method) ? body.method : null;
  if (!method) errors.push({ field: "method", message: "Choose a payment method." });
  const reference = rules.text(100)(body.reference, "Reference");
  if (reference.error) errors.push({ field: "reference", message: reference.error });
  const notes = rules.text(500)(body.notes, "Notes");
  if (notes.error) errors.push({ field: "notes", message: notes.error });
  if (errors.length) throw badRequest(errors);
  return { amount, payment_date: date.value, method, reference: reference.value, notes: notes.value };
}

/**
 * Record a payment against an invoice. The invoice row is locked for the whole
 * transaction so concurrent payments cannot together exceed the balance.
 */
async function recordPayment({ userId, business, invoiceId, body, today }) {
  return withTransaction(async (client) => {
    const invoice = (
      await client.query("SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE", [invoiceId, userId])
    ).rows[0];
    if (!invoice) throw new HttpError(404, "Invoice not found");
    if (invoice.status === "draft") throw new HttpError(409, "Issue this invoice before recording payments against it.");
    if (invoice.status === "cancelled") throw new HttpError(409, "Payments cannot be recorded on a cancelled invoice.");

    const balance = core.toUnits(invoice.total) - core.toUnits(invoice.paid_total);
    if (balance <= 0) throw new HttpError(409, "This invoice is already fully paid.");
    const payment = validatePayment(body || {}, { today, balanceUnits: balance, currency: invoice.currency });

    const receiptNumber = await allocateNumber(client, userId, business, "receipt", payment.payment_date);
    const inserted = await client.query(
      `INSERT INTO payments (invoice_id, user_id, amount, method, payment_date, paid_at, transaction_id, notes, receipt_number, source)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, 'manual')
       RETURNING id`,
      [
        invoiceId,
        userId,
        core.unitsToString(payment.amount),
        payment.method,
        payment.payment_date,
        payment.reference,
        payment.notes,
        receiptNumber,
      ]
    );
    const state = await refreshPaymentState(client, invoiceId);
    const amountText = core.formatMoney(payment.amount, invoice.currency);
    await logActivity(client, userId, {
      entityType: "payment",
      entityId: inserted.rows[0].id,
      action: "payment_recorded",
      summary: `Payment of ${amountText} recorded for ${invoice.invoice_number} (${core.paymentMethodLabel(payment.method)})`,
      metadata: { invoice_id: invoiceId, invoice_number: invoice.invoice_number, amount: core.unitsToString(payment.amount) },
    });
    if (state.status === "paid") {
      await logActivity(client, userId, {
        entityType: "invoice",
        entityId: invoiceId,
        action: "paid",
        summary: `Invoice ${invoice.invoice_number} fully paid`,
        metadata: { invoice_number: invoice.invoice_number },
      });
    }
    return { paymentId: inserted.rows[0].id, status: state.status };
  });
}

/** Void (never delete) a payment, keeping it in the audit trail. */
async function voidPayment({ userId, paymentId, reason }) {
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length < 3) throw badRequest([{ field: "reason", message: "Give a short reason for voiding this payment." }]);
  if (cleanReason.length > 300) throw badRequest([{ field: "reason", message: "Reason must be 300 characters or fewer." }]);

  return withTransaction(async (client) => {
    const payment = (
      await client.query("SELECT * FROM payments WHERE id = $1 AND user_id = $2", [paymentId, userId])
    ).rows[0];
    if (!payment) throw new HttpError(404, "Payment not found");
    const invoice = (
      await client.query("SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE", [payment.invoice_id, userId])
    ).rows[0];
    if (!invoice) throw new HttpError(404, "Invoice not found");
    const locked = (await client.query("SELECT voided_at FROM payments WHERE id = $1 FOR UPDATE", [paymentId])).rows[0];
    if (locked.voided_at) throw new HttpError(409, "This payment has already been voided.");

    await client.query("UPDATE payments SET voided_at = now(), void_reason = $1, updated_at = now() WHERE id = $2", [
      cleanReason,
      paymentId,
    ]);
    const state = await refreshPaymentState(client, payment.invoice_id);
    await logActivity(client, userId, {
      entityType: "payment",
      entityId: paymentId,
      action: "payment_voided",
      summary: `Payment of ${core.formatAmount(payment.amount, invoice.currency)} on ${invoice.invoice_number} voided: ${cleanReason}`,
      metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number, amount: payment.amount },
    });
    return { invoiceId: invoice.id, status: state.status };
  });
}

module.exports = { recordPayment, voidPayment, METHODS };
