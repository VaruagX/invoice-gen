import { html, mount, $, on } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { navigate } from "../lib/router.js";
import { emptyState, pagination, toast, toastError, confirmDialog, skeletonRows } from "../lib/ui.js";
import { money, date, plural } from "../lib/format.js";
import { openCustomerDialog } from "../components/customer-dialog.js";
import { invoiceTable, bindInvoiceActions } from "./invoices.js";
import { activityList } from "./dashboard.js";

const core = window.InvoiceCore;

export async function render({ root, params, setTitle, isCurrent }) {
  let customer = await api(`/customers/${params.id}`);
  if (!isCurrent()) return;
  let page = 1;

  const loadInvoices = async () => {
    const area = $("#custInvoices", root);
    const data = await api("/invoices", { query: { customer_id: customer.id, page, page_size: 10, sort: "issue_date", dir: "desc" } });
    if (!isCurrent()) return;
    mount(
      area,
      data.items.length
        ? html`${invoiceTable(data.items, { showCustomer: false })}${pagination({ page: data.page, pageSize: data.page_size, total: data.total })}`
        : emptyState({
            title: "No invoices yet",
            text: `Create the first invoice for ${customer.name}.`,
            actions: customer.archived_at ? "" : html`<a class="btn btn-primary" href="#/invoices/new?customer=${customer.id}">${icon("plus")}Create invoice</a>`,
          })
    );
  };

  const draw = () => {
    setTitle(customer.name);
    const state = core.stateByCode(customer.state_code);
    mount(
      root,
      html`<div class="page-header">
        <div>
          <a class="back-link" href="#/customers">${icon("chevronLeft", "icon-sm")}Customers</a>
          <div class="page-title-row"><h1>${customer.name}</h1>${customer.archived_at ? html`<span class="tag">Archived</span>` : ""}</div>
          <p>${customer.company_name || "Customer"}${customer.last_invoice_date ? ` · Last invoiced ${date(customer.last_invoice_date)}` : ""}</p>
        </div>
        <div class="actions">
          ${customer.archived_at ? "" : html`<a class="btn btn-primary" href="#/invoices/new?customer=${customer.id}">${icon("plus")}Create invoice</a>`}
          <button type="button" class="btn btn-secondary" data-action="edit">${icon("edit")}Edit</button>
          <div class="menu-wrap">
            <button type="button" class="btn btn-secondary btn-icon" data-menu-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">${icon("more")}</button>
            <div class="menu" role="menu" hidden>
              ${customer.archived_at
                ? html`<button type="button" class="menu-item" data-action="restore">${icon("restore")}Restore customer</button>`
                : html`<button type="button" class="menu-item" data-action="archive">${icon("archive")}Archive customer</button>`}
              <div class="menu-sep"></div>
              <button type="button" class="menu-item danger" data-action="delete">${icon("trash")}Delete customer</button>
            </div>
          </div>
        </div>
      </div>
      ${customer.archived_at ? html`<div class="callout callout-warning" style="margin-bottom:16px">${icon("archive")}<span>This customer is archived: hidden from pickers but their invoices and history are kept.</span></div>` : ""}
      <div class="summary-strip">
        <div class="card"><span class="label">Total invoiced</span><span class="value">${money(customer.total_invoiced)}</span><span class="small muted">${plural(customer.issued_count, "invoice")}</span></div>
        <div class="card"><span class="label">Total paid</span><span class="value">${money(customer.total_paid)}</span></div>
        <div class="card"><span class="label">Balance due</span><span class="value">${money(customer.outstanding)}</span></div>
        <div class="card"><span class="label">Overdue</span><span class="value" style="${customer.overdue_count ? "color:var(--danger)" : ""}">${money(customer.overdue_amount)}</span><span class="small muted">${plural(customer.overdue_count, "invoice")}</span></div>
      </div>
      <div class="grid-main-side">
        <section class="card">
          <div class="card-header"><div><h2>Invoice history</h2></div><a class="btn btn-ghost btn-sm" href="#/invoices?customer_id=${customer.id}">Open in invoices ${icon("chevronRight", "icon-sm")}</a></div>
          <div id="custInvoices">${skeletonRows(4)}</div>
        </section>
        <div class="stack">
          <section class="card">
            <div class="card-header"><h2>Details</h2></div>
            <div class="card-body">
              <dl class="details-list">
                <dt>Email</dt><dd>${customer.email ? html`<a href="mailto:${customer.email}">${customer.email}</a>` : "—"}</dd>
                <dt>Phone</dt><dd>${customer.phone ? html`<a href="tel:${customer.phone.replace(/[^+\d]/g, "")}">${customer.phone}</a>` : "—"}</dd>
                <dt>GSTIN</dt><dd>${customer.gst_number || "Not registered / not provided"}</dd>
                <dt>PAN</dt><dd>${customer.pan || "—"}</dd>
                <dt>State</dt><dd>${state ? `${state.name} (${state.code})` : customer.state || "—"}</dd>
                <dt>Billing</dt><dd style="white-space:pre-line">${[customer.address, [customer.city, customer.postal_code].filter(Boolean).join(" "), customer.country].filter(Boolean).join("\n") || "—"}</dd>
                <dt>Shipping</dt><dd style="white-space:pre-line">${customer.shipping_address || "Same as billing / not set"}</dd>
                ${customer.notes ? html`<dt>Notes</dt><dd style="white-space:pre-line">${customer.notes}</dd>` : ""}
              </dl>
            </div>
          </section>
          <section class="card"><div class="card-header"><h2>Activity</h2></div><div class="card-body">${activityList(customer.activity || [])}</div></section>
        </div>
      </div>`
    );
    loadInvoices().catch(toastError);
  };

  const reload = async () => {
    customer = await api(`/customers/${customer.id}`);
    if (isCurrent()) draw();
  };

  draw();
  on(root, "click", "[data-page]", (button) => {
    page = Number(button.dataset.page);
    loadInvoices().catch(toastError);
  });
  bindInvoiceActions(root, () => reload().catch(toastError));
  on(root, "click", "[data-action]", async (el) => {
    const action = el.dataset.action;
    try {
      if (action === "edit") openCustomerDialog({ customer, onSaved: () => reload() });
      else if (action === "archive" || action === "restore") {
        await api(`/customers/${customer.id}/${action}`, { method: "POST" });
        toast(action === "archive" ? `${customer.name} archived.` : `${customer.name} restored.`);
        reload();
      } else if (action === "delete") {
        if (customer.invoice_count > 0) {
          const archive = await confirmDialog({
            title: "This customer has invoices",
            message: `${customer.name} has ${plural(customer.invoice_count, "invoice")}, so deleting would break your records. Archive them instead to hide them from lists while keeping their history.`,
            confirmLabel: "Archive instead",
          });
          if (archive) {
            await api(`/customers/${customer.id}/archive`, { method: "POST" });
            toast(`${customer.name} archived.`);
            reload();
          }
          return;
        }
        const ok = await confirmDialog({ title: `Delete ${customer.name}?`, message: "This customer has no invoices and will be permanently deleted.", confirmLabel: "Delete customer", danger: true });
        if (!ok) return;
        await api(`/customers/${customer.id}`, { method: "DELETE" });
        toast(`${customer.name} deleted.`);
        navigate("/customers");
      }
    } catch (error) {
      toastError(error);
    }
  });
}
