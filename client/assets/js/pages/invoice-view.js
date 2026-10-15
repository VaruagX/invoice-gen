import { html, mount, $, on } from "../lib/dom.js";
import { api, download } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { store, getSettings } from "../lib/store.js";
import { navigate } from "../lib/router.js";
import { statusPill, toast, toastError, confirmDialog, openModal, withBusy, copyText } from "../lib/ui.js";
import { money, date, plural, methodLabel } from "../lib/format.js";
import { renderInvoiceDocument, fromSaved } from "../components/invoice-document.js";
import { openPaymentDialog } from "../components/payment-dialog.js";
import { activityList } from "./dashboard.js";

const core = window.InvoiceCore;

function dueIn(dueDate) {
  const days = core.daysBetween(store.today, dueDate);
  return days === 0 ? "due today" : `in ${plural(days, "day")}`;
}

function actionsFor(inv) {
  const open = ["unpaid", "partially_paid"].includes(inv.status);
  const primary = [];
  const menu = [];
  if (inv.status === "draft") {
    primary.push(html`<a class="btn btn-secondary" href="#/invoices/${inv.id}/edit">${icon("edit")}Edit</a>`);
    primary.push(html`<button type="button" class="btn btn-primary" data-action="issue">${icon("send")}Issue invoice</button>`);
  } else if (open) {
    primary.push(html`<a class="btn btn-secondary hide-sm" href="#/invoices/${inv.id}/edit">${icon("edit")}Edit</a>`);
    primary.push(html`<button type="button" class="btn btn-primary" data-action="pay">${icon("wallet")}Record payment</button>`);
    menu.push(html`<button type="button" class="menu-item" data-action="mark-paid">${icon("checkCircle")}Mark as paid</button>`);
    menu.push(html`<button type="button" class="menu-item" data-action="reminder">${icon("mail")}Prepare reminder</button>`);
  } else if (inv.status === "cancelled") {
    primary.push(html`<button type="button" class="btn btn-primary" data-action="restore">${icon("restore")}Restore invoice</button>`);
  } else {
    menu.push(html`<a class="menu-item" href="#/invoices/${inv.id}/edit">${icon("edit")}Edit</a>`);
  }
  primary.push(html`<button type="button" class="btn btn-secondary" data-action="pdf">${icon("download")}<span>Download PDF</span></button>`);
  menu.push(html`<button type="button" class="menu-item" data-action="print">${icon("printer")}Print</button>`);
  menu.push(html`<button type="button" class="menu-item" data-action="duplicate">${icon("copy")}Duplicate</button>`);
  if (open && core.toUnits(inv.paid_total) === 0) {
    menu.push(html`<div class="menu-sep"></div><button type="button" class="menu-item danger" data-action="cancel">${icon("ban")}Cancel invoice</button>`);
  }
  if (!inv.payments.length) {
    menu.push(html`<div class="menu-sep"></div><button type="button" class="menu-item danger" data-action="delete">${icon("trash")}Delete</button>`);
  }
  return html`${primary}
    <div class="menu-wrap">
      <button type="button" class="btn btn-secondary btn-icon" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">${icon("more")}</button>
      <div class="menu" role="menu" hidden>${menu}</div>
    </div>`;
}

function paymentsCard(inv) {
  const active = inv.payments.filter((p) => !p.voided_at);
  return html`<section class="card">
    <div class="card-header">
      <div><h2>Payments</h2><p>${active.length ? `${plural(active.length, "payment")} · ${money(inv.paid_total, inv.currency)} received` : "No payments recorded yet"}</p></div>
      ${["unpaid", "partially_paid"].includes(inv.status) ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="pay">${icon("plus", "icon-sm")}Add</button>` : ""}
    </div>
    <div class="card-body" style="padding-top:4px;padding-bottom:4px">
      ${inv.payments.length
        ? inv.payments.map(
            (p) => html`<div class="payment-item${p.voided_at ? " voided" : ""}">
              <div>
                <strong>${date(p.payment_date)}</strong> · ${methodLabel(p.method)}
                ${p.voided_at ? html` <span class="pill pill-voided">Voided</span>` : ""}
              </div>
              <span class="amount">${money(p.amount, inv.currency)}</span>
              <div class="meta">
                ${p.receipt_number || ""}${p.reference ? ` · Ref ${p.reference}` : ""}${p.source === "migration" ? " · Recorded during upgrade" : ""}
                ${p.notes ? html`<div>${p.notes}</div>` : ""}
                ${p.voided_at ? html`<div style="color:var(--danger)">Voided: ${p.void_reason}</div>` : ""}
                <div class="actions" style="margin-top:6px">
                  <button type="button" class="btn btn-ghost btn-sm" data-action="receipt" data-id="${p.id}" data-number="${p.receipt_number || "receipt"}">${icon("receipt", "icon-sm")}Receipt</button>
                  ${p.voided_at ? "" : html`<button type="button" class="btn btn-danger-ghost btn-sm" data-action="void" data-id="${p.id}" data-amount="${p.amount}">Void</button>`}
                </div>
              </div>
            </div>`
          )
        : html`<p class="muted small" style="padding:12px 0">${inv.status === "draft" ? "Issue this invoice to start recording payments." : "Record payments as you receive them to keep the balance accurate."}</p>`}
    </div>
  </section>`;
}

function openReminder(inv) {
  api(`/invoices/${inv.id}/reminder`)
    .then((reminder) => {
      const { dialog } = openModal({
        title: "Payment reminder",
        description: "Invoice Studio doesn't send messages. Copy this text or open it in your email or WhatsApp to send it yourself.",
        wide: true,
        body: html`<div class="stack-sm">
          <div class="field"><label for="remSubject">Subject</label><input class="input" id="remSubject" value="${reminder.subject}"></div>
          <div class="field"><label for="remBody">Message</label><textarea class="textarea reminder-text" id="remBody">${reminder.body}</textarea></div>
          <p class="muted small">${reminder.email || reminder.phone ? `Contact: ${[reminder.email, reminder.phone].filter(Boolean).join(" · ")}` : "This customer has no email or phone saved."}</p>
        </div>`,
        footer: html`<button type="button" class="btn btn-secondary" data-close>Close</button>
          <button type="button" class="btn btn-secondary" id="remCopy">${icon("copy")}Copy text</button>
          ${reminder.whatsapp_url ? html`<a class="btn btn-secondary" id="remWa" href="${reminder.whatsapp_url}" target="_blank" rel="noopener noreferrer">${icon("message")}WhatsApp</a>` : ""}
          ${reminder.email ? html`<a class="btn btn-primary" id="remMail" href="${reminder.mailto_url}">${icon("mail")}Open email</a>` : ""}`,
      });
      const subject = $("#remSubject", dialog);
      const body = $("#remBody", dialog);
      const refreshLinks = () => {
        const mail = $("#remMail", dialog);
        if (mail) mail.href = `mailto:${encodeURIComponent(reminder.email)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(body.value)}`;
        const wa = $("#remWa", dialog);
        if (wa) wa.href = reminder.whatsapp_url.replace(/\?text=.*$/, `?text=${encodeURIComponent(body.value)}`);
      };
      subject.addEventListener("input", refreshLinks);
      body.addEventListener("input", refreshLinks);
      $("#remCopy", dialog).addEventListener("click", () =>
        copyText(`${subject.value}\n\n${body.value}`).then(() => toast("Reminder copied to clipboard."))
      );
    })
    .catch(toastError);
}

export { openReminder };

export async function render({ root, params, setTitle, isCurrent }) {
  const [invoice, settings] = await Promise.all([api(`/invoices/${params.id}`), getSettings()]);
  if (!isCurrent()) return;
  let inv = invoice;

  const draw = () => {
    setTitle(inv.invoice_number);
    const open = ["unpaid", "partially_paid"].includes(inv.status);
    mount(
      root,
      html`<div class="page-header">
        <div>
          <a class="back-link" href="#/invoices">${icon("chevronLeft", "icon-sm")}Invoices</a>
          <div class="page-title-row"><h1>${inv.invoice_number}</h1>${statusPill(inv.display_status)}</div>
          <p>${inv.customer_record
            ? html`<a href="#/customers/${inv.customer_record.id}">${inv.customer?.name || inv.customer_record.name}</a>`
            : inv.customer?.name || "No customer"} · Issued ${date(inv.issue_date)}${inv.duplicated_from ? html` · <a href="#/invoices/${inv.duplicated_from}">copied from another invoice</a>` : ""}</p>
        </div>
        <div class="actions">${actionsFor(inv)}</div>
      </div>

      ${inv.status === "draft" ? html`<div class="callout callout-info" style="margin-bottom:16px">${icon("info")}<span>This is a draft. It isn't counted in revenue or outstanding totals until you issue it.</span></div>` : ""}
      ${inv.is_overdue
        ? html`<div class="callout callout-danger" style="margin-bottom:16px;align-items:center">${icon("alert")}<span style="flex:1">Overdue by ${plural(inv.days_overdue, "day")} — ${money(inv.balance_due, inv.currency)} is still due.</span><button type="button" class="btn btn-secondary btn-sm" data-action="reminder">${icon("mail", "icon-sm")}Prepare reminder</button></div>`
        : ""}
      ${inv.status === "cancelled" ? html`<div class="callout callout-warning" style="margin-bottom:16px">${icon("ban")}<span>Cancelled${inv.cancel_reason ? `: ${inv.cancel_reason}` : ""}. Cancelled invoices are excluded from revenue and outstanding totals.</span></div>` : ""}

      <div class="summary-strip">
        <div class="card"><span class="label">Invoice total</span><span class="value">${money(inv.total, inv.currency)}</span></div>
        <div class="card"><span class="label">Amount paid</span><span class="value">${money(inv.paid_total, inv.currency)}</span></div>
        <div class="card"><span class="label">Balance due</span><span class="value">${inv.status === "cancelled" ? "—" : money(inv.balance_due, inv.currency)}</span></div>
        <div class="card"><span class="label">${open ? "Payment due" : "Due date"}</span><span class="value" style="font-size:16px">${date(inv.due_date)}</span>
          ${inv.is_overdue ? html`<span class="small" style="color:var(--danger)">${plural(inv.days_overdue, "day")} overdue</span>` : open && inv.next_payment_due ? html`<span class="small muted">${dueIn(inv.next_payment_due)}</span>` : ""}</div>
      </div>

      <div class="grid-main-side print-area-wrap">
        <div class="print-area">${renderInvoiceDocument(fromSaved(inv, settings))}</div>
        <div class="stack no-print">
          ${paymentsCard(inv)}
          <section class="card"><div class="card-header"><h2>Activity</h2></div><div class="card-body">${activityList(inv.activity || [])}</div></section>
        </div>
      </div>`
    );
  };

  const reload = async () => {
    inv = await api(`/invoices/${inv.id}`);
    if (isCurrent()) draw();
  };

  draw();

  on(root, "click", "[data-action]", async (el) => {
    const action = el.dataset.action;
    try {
      if (action === "pay") openPaymentDialog({ invoice: inv, onSaved: () => reload() });
      else if (action === "mark-paid") openPaymentDialog({ invoice: inv, markPaid: true, onSaved: () => reload() });
      else if (action === "pdf") await withBusy(el, () => download(`/invoices/${inv.id}/pdf`, `${inv.invoice_number}.pdf`));
      else if (action === "receipt") await download(`/payments/${el.dataset.id}/receipt`, `${el.dataset.number}.pdf`);
      else if (action === "print") {
        document.body.classList.add("printing-invoice");
        window.addEventListener("afterprint", () => document.body.classList.remove("printing-invoice"), { once: true });
        window.print();
      } else if (action === "reminder") openReminder(inv);
      else if (action === "issue") {
        await withBusy(el, () => api(`/invoices/${inv.id}/issue`, { method: "POST" }));
        toast(`${inv.invoice_number} issued.`);
        window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
        reload();
      } else if (action === "duplicate") {
        const copy = await api(`/invoices/${inv.id}/duplicate`, { method: "POST" });
        toast(`Draft ${copy.invoice_number} created.`, { title: "Invoice duplicated" });
        navigate(`/invoices/${copy.id}/edit`);
      } else if (action === "restore") {
        await withBusy(el, () => api(`/invoices/${inv.id}/restore`, { method: "POST" }));
        toast(`${inv.invoice_number} restored.`);
        reload();
      } else if (action === "cancel") {
        openModal({
          title: `Cancel ${inv.invoice_number}?`,
          description: "The invoice stays in your records marked as cancelled, and is excluded from revenue and outstanding totals. You can restore it later.",
          body: html`<div class="field"><label for="cancelReason">Reason <span class="optional">(optional)</span></label><input class="input" id="cancelReason" name="reason" maxlength="300" placeholder="e.g. Raised in error"></div>`,
          footer: html`<button type="button" class="btn btn-secondary" data-close>Keep invoice</button><button type="submit" class="btn btn-danger">Cancel invoice</button>`,
          onSubmit: async (form) => {
            await api(`/invoices/${inv.id}/cancel`, { method: "POST", body: { reason: form.reason.value } });
            toast(`${inv.invoice_number} cancelled.`);
            window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
            reload();
          },
        });
      } else if (action === "void") {
        openModal({
          title: `Void payment of ${money(el.dataset.amount, inv.currency)}?`,
          description: "The payment stays in the history marked as voided, and the invoice balance goes back up. Use this for bounced cheques or entries made in error.",
          body: html`<div class="field"><label for="voidReason">Reason</label><input class="input" id="voidReason" name="reason" maxlength="300" required placeholder="e.g. Cheque bounced"></div>`,
          footer: html`<button type="button" class="btn btn-secondary" data-close>Keep payment</button><button type="submit" class="btn btn-danger">Void payment</button>`,
          onSubmit: async (form) => {
            await api(`/payments/${el.dataset.id}/void`, { method: "POST", body: { reason: form.reason.value } });
            toast("Payment voided.");
            window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
            reload();
          },
        });
      } else if (action === "delete") {
        const ok = await confirmDialog({
          title: `Delete ${inv.invoice_number}?`,
          message:
            inv.status === "draft"
              ? "This draft will be permanently deleted."
              : "This permanently deletes the invoice and leaves a gap in your numbering. Consider cancelling it instead to keep a record.",
          confirmLabel: "Delete invoice",
          danger: true,
        });
        if (!ok) return;
        await api(`/invoices/${inv.id}`, { method: "DELETE" });
        toast(`${inv.invoice_number} deleted.`);
        window.dispatchEvent(new CustomEvent("invoice-studio:changed"));
        navigate("/invoices");
      }
    } catch (error) {
      toastError(error);
    }
  });
}
