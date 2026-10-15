import { html, mount, $, on } from "../lib/dom.js";
import { api, download } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { store } from "../lib/store.js";
import { replaceQuery } from "../lib/router.js";
import { statusPill, emptyState, toastError, skeletonRows } from "../lib/ui.js";
import { money, date, relativeTime, plural, percentChange, monthLabel, number } from "../lib/format.js";
import { revenueChart } from "../components/charts.js";
import { openPaymentDialog } from "../components/payment-dialog.js";
import { openCustomerDialog } from "../components/customer-dialog.js";

const core = window.InvoiceCore;

const RANGES = [
  { value: "7d", label: "7D", long: "last 7 days" },
  { value: "30d", label: "30D", long: "last 30 days" },
  { value: "3m", label: "3M", long: "last 3 months" },
  { value: "6m", label: "6M", long: "last 6 months" },
  { value: "12m", label: "12M", long: "last 12 months" },
  { value: "custom", label: "Custom", long: "selected period" },
];

const ACTIVITY_ICONS = {
  created: "invoice",
  issued: "send",
  updated: "edit",
  duplicated: "copy",
  deleted: "trash",
  cancelled: "ban",
  restored: "restore",
  paid: "checkCircle",
  payment_recorded: "wallet",
  payment_voided: "ban",
  archived: "archive",
  asset_uploaded: "image",
  asset_removed: "image",
};

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function deltaBadge(current, previous, { money: isMoney = false, label }) {
  const change = isMoney ? percentChange(current, previous) : previous ? ((current - previous) / previous) * 100 : null;
  if (change === null) return html`<span class="kpi-sub">No data for the previous ${label}</span>`;
  const rounded = Math.round(change);
  const cls = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return html`<span class="kpi-sub"><span class="delta ${cls}">${rounded > 0 ? icon("arrowUp", "icon-sm") : rounded < 0 ? icon("arrowDown", "icon-sm") : ""}${rounded > 0 ? "+" : ""}${rounded}%</span> vs previous ${label}</span>`;
}

function kpi({ label, iconName, value, sub, href }) {
  const body = html`<span class="kpi-label"><span class="kpi-icon">${icon(iconName)}</span>${label}</span>
    <span class="kpi-value" title="${String(value)}">${value}</span>${sub}`;
  return href ? html`<a class="card kpi" href="${href}">${body}</a>` : html`<div class="card kpi">${body}</div>`;
}

function activityList(items) {
  if (!items.length) return html`<p class="muted small">Activity such as new invoices and payments will appear here.</p>`;
  return html`<ul class="timeline">${items.map(
    (item) => html`<li>
      <span class="dot">${icon(ACTIVITY_ICONS[item.action] || "info")}</span>
      <div>
        ${item.entity_type === "invoice" && item.entity_id && item.action !== "deleted"
          ? html`<a href="#/invoices/${item.entity_id}" class="row-link" style="font-weight:500">${item.summary}</a>`
          : item.entity_type === "customer" && item.entity_id && item.action !== "deleted"
            ? html`<a href="#/customers/${item.entity_id}" class="row-link" style="font-weight:500">${item.summary}</a>`
            : html`<span>${item.summary}</span>`}
        <div class="when">${relativeTime(item.created_at)}</div>
      </div>
    </li>`
  )}</ul>`;
}

export { activityList };

function recentTable(rows) {
  return html`<div class="table-wrap"><table class="table responsive">
    <thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th class="num">Amount</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map(
      (inv) => html`<tr>
        <td class="primary-cell"><a class="row-link" href="#/invoices/${inv.id}">${inv.invoice_number}</a></td>
        <td data-label="Customer">${inv.customer_name || html`<span class="faint">No customer</span>`}</td>
        <td data-label="Due" class="nowrap">${date(inv.due_date)}</td>
        <td data-label="Amount" class="num strong">${money(inv.total, inv.currency)}</td>
        <td data-label="Status">${statusPill(inv.display_status)}</td>
        <td class="actions-cell"><div class="row-actions">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="pdf" data-id="${inv.id}" data-number="${inv.invoice_number}" aria-label="Download ${inv.invoice_number} as PDF" title="Download PDF">${icon("download", "icon-sm")}</button>
          ${["unpaid", "partially_paid"].includes(inv.status)
            ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="pay" data-id="${inv.id}" aria-label="Record payment for ${inv.invoice_number}" title="Record payment">${icon("wallet", "icon-sm")}</button>`
            : ""}
        </div></td>
      </tr>`
    )}</tbody>
  </table></div>`;
}

function setupSteps() {
  const steps = [
    { done: store.setup.profile_complete, title: "Complete your business profile", text: "Name, address, state and GSTIN appear on every invoice.", href: "#/settings" },
    { done: store.counts.customers > 0, title: "Add your first customer", text: "Save billing details once and reuse them.", href: "#/customers?new=1" },
    { done: store.counts.invoices > 0, title: "Create an invoice", text: "Build it with a live preview, then download a PDF.", href: "#/invoices/new" },
  ];
  return html`<section class="card" style="margin-bottom:20px">
    <div class="card-header"><div><h2>Get set up</h2><p>Three quick steps to send your first professional invoice.</p></div></div>
    <div class="card-body"><div class="setup-steps">${steps.map(
      (step, i) => html`<a class="setup-step${step.done ? " done" : ""}" href="${step.href}">
        <span class="num-badge">${step.done ? icon("check", "icon-sm") : i + 1}</span>
        <div><h3>${step.title}</h3><p>${step.done ? "Done" : step.text}</p></div>
      </a>`
    )}</div></div>
  </section>`;
}

function renderBody(container, data) {
  const c = data.cards;
  const currency = store.business?.currency || "INR";
  const rangeInfo = RANGES.find((r) => r.value === data.period.range) || RANGES[1];
  const periodLabel = data.period.range === "custom" ? `${date(data.period.from)} – ${date(data.period.to)}` : rangeInfo.long;
  const prevLabel = data.period.range === "custom" ? "period" : rangeInfo.long.replace("last ", "");
  const showSetup = !store.setup.profile_complete || !store.counts.invoices || !store.counts.customers;

  if (!data.has_data) {
    mount(
      container,
      html`${setupSteps()}
      <section class="card">${emptyState({
        iconName: "chart",
        title: "Your dashboard fills in as you work",
        text: "Revenue, outstanding balances and overdue invoices are calculated from the invoices and payments you record. Nothing here is sample data.",
        actions: html`<a class="btn btn-primary" href="#/invoices/new">${icon("plus")}Create invoice</a>
          <button class="btn btn-secondary" type="button" data-action="add-customer">${icon("users")}Add customer</button>`,
      })}</section>`
    );
    return;
  }

  const statusMax = Math.max(...data.status_overview.map((s) => s.count), 1);
  const status = data.status_overview;
  const insights = data.insights;

  mount(
    container,
    html`${showSetup ? setupSteps() : ""}
    <div class="kpi-grid" style="margin-bottom:20px">
      ${kpi({
        label: "Total invoices",
        iconName: "invoice",
        value: number(c.total_invoices),
        sub: deltaBadge(c.total_invoices, c.previous_total_invoices, { label: prevLabel }),
        href: "#/invoices",
      })}
      ${kpi({
        label: "Paid invoices",
        iconName: "checkCircle",
        value: number(c.paid_invoices),
        sub: html`<span class="kpi-sub">of ${plural(c.total_invoices, "invoice")} issued in period</span>`,
        href: "#/invoices?status=paid",
      })}
      ${kpi({
        label: "Unpaid invoices",
        iconName: "clock",
        value: number(c.unpaid_invoices),
        sub: html`<span class="kpi-sub">${c.partially_paid_invoices ? `${c.partially_paid_invoices} partially paid` : "issued in period, awaiting payment"}</span>`,
        href: "#/invoices?status=open",
      })}
      ${kpi({
        label: "Overdue",
        iconName: "alert",
        value: number(c.overdue_invoices),
        sub: html`<span class="kpi-sub">${money(c.overdue_amount, currency)} due · as of today</span>`,
        href: "#/overdue",
      })}
      ${kpi({
        label: "Revenue collected",
        iconName: "wallet",
        value: money(c.collected, currency),
        sub: deltaBadge(c.collected, c.previous_collected, { money: true, label: prevLabel }),
        href: "#/payments",
      })}
      ${kpi({
        label: "Outstanding",
        iconName: "rupee",
        value: money(c.outstanding, currency),
        sub: html`<span class="kpi-sub">${plural(c.open_invoices, "open invoice")} · all dates</span>`,
        href: "#/invoices?status=open",
      })}
    </div>

    <div class="grid-main-side" style="margin-bottom:20px">
      <section class="card chart-card">
        <div class="card-header">
          <div><h2>Revenue analytics</h2><p>Invoiced (issued invoices) vs collected (recorded payments), ${periodLabel}</p></div>
          <div class="muted small">Invoiced ${money(c.invoiced, currency)} · Collected ${money(c.collected, currency)}</div>
        </div>
        <div class="card-body" id="revenueChart"></div>
      </section>
      <section class="card">
        <div class="card-header"><div><h2>Invoice status</h2><p>Invoices issued ${periodLabel}</p></div></div>
        <div class="card-body" style="padding:10px 8px">
          <div class="status-list">${status.map(
            (row) => html`<a class="status-row" href="${row.status === "overdue" ? "#/overdue" : `#/invoices?status=${row.status}`}">
              <span>${statusPill(row.status)}</span>
              <span class="figures"><strong>${row.count}</strong> <span class="muted small">· ${money(row.amount, currency)}</span></span>
              <span class="meter" aria-hidden="true"><span style="width:${row.count ? Math.max((row.count / statusMax) * 100, 2) : 0}%"></span></span>
            </a>`
          )}</div>
        </div>
      </section>
    </div>

    <div class="grid-main-side" style="margin-bottom:20px">
      <section class="card">
        <div class="card-header"><div><h2>Recent invoices</h2><p>Latest invoices you created</p></div><a class="btn btn-ghost btn-sm" href="#/invoices">View all ${icon("chevronRight", "icon-sm")}</a></div>
        <div class="card-body tight">${data.recent_invoices.length ? recentTable(data.recent_invoices) : emptyState({ title: "No invoices yet" })}</div>
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-header"><h2>Quick actions</h2></div>
          <div class="card-body"><div class="quick-actions">
            <a class="quick-action" href="#/invoices/new">${icon("plus")}Create invoice</a>
            <button type="button" class="quick-action" data-action="add-customer">${icon("users")}Add customer</button>
            <a class="quick-action" href="#/overdue">${icon("alert")}View overdue</a>
            <button type="button" class="quick-action" data-action="record-payment">${icon("wallet")}Record payment</button>
            <a class="quick-action" href="#/invoices">${icon("invoice")}All invoices</a>
            <a class="quick-action" href="#/reports">${icon("chart")}Reports</a>
          </div></div>
        </section>
        <section class="card">
          <div class="card-header"><h2>Recent activity</h2></div>
          <div class="card-body">${activityList(data.recent_activity)}</div>
        </section>
      </div>
    </div>

    <section class="card">
      <div class="card-header"><div><h2>Business insights</h2><p>Based on your saved invoices and recorded payments</p></div></div>
      <div class="card-body">
        <div class="grid-2">
          <div>
            <h3 style="margin-bottom:8px">Most valuable customers <span class="muted small">(${periodLabel})</span></h3>
            ${insights.top_customers.length
              ? html`<ul class="insight-list">${insights.top_customers.map(
                  (row) => html`<li><a href="#/customers/${row.customer_id}">${row.name}</a>
                    <span class="num"><strong>${money(row.invoiced, currency)}</strong> <span class="muted small">invoiced · ${money(row.outstanding, currency)} due</span></span></li>`
                )}</ul>`
              : html`<p class="muted small">No invoices with customers in this period.</p>`}
          </div>
          <div>
            <h3 style="margin-bottom:8px">At a glance</h3>
            <ul class="insight-list">
              <li><span class="muted">Average invoice value</span><strong class="num">${insights.average_invoice ? money(insights.average_invoice, currency) : "—"}</strong></li>
              <li><span class="muted">Average time to get paid <span class="faint small">(last 12 months)</span></span><strong>${insights.average_days_to_pay !== null ? plural(insights.average_days_to_pay, "day") : "—"}</strong></li>
              <li><span class="muted">Total outstanding</span><strong class="num">${money(insights.outstanding, currency)}</strong></li>
              <li><span class="muted">Oldest overdue invoice</span><strong>${insights.oldest_overdue_days ? `${plural(insights.oldest_overdue_days, "day")} late` : "None"}</strong></li>
              <li><span class="muted">Best months for collections <span class="faint small">(last 12 months)</span></span>
                <strong>${insights.best_months.length ? insights.best_months.map((m) => `${monthLabel(m.month)} (${money(m.collected, currency)})`).join(", ") : "—"}</strong></li>
            </ul>
          </div>
        </div>
      </div>
    </section>`
  );

  revenueChart($("#revenueChart", container), { series: data.series, granularity: data.period.bucket, currency });
}

export async function render({ root, query, setTitle, isCurrent }) {
  setTitle("Dashboard");
  const state = {
    range: RANGES.some((r) => r.value === query.range) ? query.range : "30d",
    from: query.from || core.addDays(store.today, -29),
    to: query.to || store.today,
  };
  const firstName = (store.user.name || "").split(" ")[0];

  mount(
    root,
    html`<div class="page-header">
      <div>
        <div class="eyebrow">${date(store.today)}</div>
        <h1>${greeting()}${firstName ? `, ${firstName}` : ""}</h1>
        <p>Here's how ${store.business?.name || "your business"} is doing.</p>
      </div>
      <div class="dash-filters" role="group" aria-label="Dashboard period">
        <div class="segmented">${RANGES.map(
          (r) => html`<button type="button" data-range="${r.value}" aria-pressed="${String(r.value === state.range)}">${r.label}</button>`
        )}</div>
        <div class="custom-range" id="customRange" ${state.range === "custom" ? "" : "hidden"}>
          <label class="sr-only" for="rangeFrom">From</label>
          <input class="input" type="date" id="rangeFrom" value="${state.from}" max="${store.today}">
          <span class="muted">to</span>
          <label class="sr-only" for="rangeTo">To</label>
          <input class="input" type="date" id="rangeTo" value="${state.to}" max="${store.today}">
        </div>
      </div>
    </div>
    <div id="dashBody">${skeletonRows(8)}</div>`
  );

  const body = $("#dashBody", root);
  let controller;

  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    body.style.opacity = body.children.length ? "0.55" : "1";
    try {
      const params = { range: state.range };
      if (state.range === "custom") Object.assign(params, { from: state.from, to: state.to });
      replaceQuery(state.range === "30d" ? {} : params);
      const data = await api("/dashboard", { query: params, signal: controller.signal });
      if (!isCurrent()) return;
      renderBody(body, data);
    } catch (error) {
      if (error.name !== "AbortError") toastError(error);
    } finally {
      body.style.opacity = "1";
    }
  };

  on(root, "click", "[data-range]", (button) => {
    state.range = button.dataset.range;
    root.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    $("#customRange", root).hidden = state.range !== "custom";
    if (state.range !== "custom") load();
    else if (state.from && state.to) load();
  });
  ["#rangeFrom", "#rangeTo"].forEach((id) =>
    $(id, root).addEventListener("change", () => {
      state.from = $("#rangeFrom", root).value;
      state.to = $("#rangeTo", root).value;
      if (state.from && state.to && state.from <= state.to) load();
    })
  );
  on(root, "click", "[data-action]", async (el) => {
    const action = el.dataset.action;
    if (action === "add-customer") openCustomerDialog({ onSaved: () => load() });
    else if (action === "record-payment") openPaymentDialog({ onSaved: () => load() });
    else if (action === "pay") {
      try {
        const invoice = await api(`/invoices/${el.dataset.id}`);
        openPaymentDialog({ invoice, onSaved: () => load() });
      } catch (error) {
        toastError(error);
      }
    } else if (action === "pdf") {
      download(`/invoices/${el.dataset.id}/pdf`, `${el.dataset.number}.pdf`).catch(toastError);
    }
  });

  await load();
}
