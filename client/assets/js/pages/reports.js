import { html, mount, $, on, debounce } from "../lib/dom.js";
import { api, download } from "../lib/api.js";
import { icon } from "../lib/icons.js";
import { store } from "../lib/store.js";
import { replaceQuery } from "../lib/router.js";
import { emptyState, toastError, withBusy, skeletonRows } from "../lib/ui.js";
import { money, date, number } from "../lib/format.js";

const core = window.InvoiceCore;

const ICONS = {
  revenue: "chart",
  "paid-invoices": "checkCircle",
  outstanding: "clock",
  overdue: "alert",
  "customer-revenue": "users",
  "monthly-summary": "calendar",
  payments: "wallet",
  "tax-summary": "percent",
};

function presets(today) {
  const year = Number(today.slice(0, 4));
  const fyStart = Number(today.slice(5, 7)) >= 4 ? year : year - 1;
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthEnd = core.addDays(monthStart, -1);
  const prevMonthStart = `${prevMonthEnd.slice(0, 7)}-01`;
  const threeMonths = new Date(`${monthStart}T00:00:00Z`);
  threeMonths.setUTCMonth(threeMonths.getUTCMonth() - 2);
  return [
    { value: "fy", label: `This financial year (FY ${core.financialYear(today)})`, from: `${fyStart}-04-01`, to: today },
    { value: "last_fy", label: `Last financial year (FY ${core.financialYear(`${fyStart - 1}-04-01`)})`, from: `${fyStart - 1}-04-01`, to: `${fyStart}-03-31` },
    { value: "month", label: "This month", from: monthStart, to: today },
    { value: "last_month", label: "Last month", from: prevMonthStart, to: prevMonthEnd },
    { value: "3m", label: "Last 3 months", from: threeMonths.toISOString().slice(0, 10), to: today },
    { value: "custom", label: "Custom range" },
  ];
}

function cell(value, type, currency) {
  if (value === null || value === undefined || value === "") return html`<span class="faint">—</span>`;
  if (type === "money") return money(value, currency);
  if (type === "date") return date(value);
  if (type === "percent") return `${value}%`;
  if (type === "number") return number(value);
  return String(value);
}

export async function render({ root, query, setTitle, isCurrent }) {
  setTitle("Reports");
  const reports = await api("/reports");
  if (!isCurrent()) return;
  const presetList = presets(store.today);
  const state = {
    type: reports.some((r) => r.key === query.type) ? query.type : "revenue",
    preset: presetList.some((p) => p.value === query.preset) ? query.preset : "fy",
    from: query.from || presetList[0].from,
    to: query.to || store.today,
    search: query.search || "",
  };
  if (state.preset !== "custom") Object.assign(state, presetList.find((p) => p.value === state.preset));

  mount(
    root,
    html`<div class="page-header">
      <div><h1>Reports</h1><p>Summaries calculated from your saved invoices and recorded payments. Export to CSV or PDF, or print.</p></div>
    </div>
    <div class="report-layout">
      <nav class="card report-list" aria-label="Reports" role="tablist">${reports.map(
        (r) => html`<button type="button" role="tab" data-type="${r.key}" aria-selected="${String(r.key === state.type)}">${icon(ICONS[r.key] || "chart")}${r.title}</button>`
      )}</nav>
      <section class="card">
        <div class="card-header no-print">
          <div class="toolbar" style="margin:0;flex:1">
            <label class="sr-only" for="rPreset">Period</label>
            <select class="select" id="rPreset">${presetList.map((p) => html`<option value="${p.value}" ${p.value === state.preset ? "selected" : ""}>${p.label}</option>`)}</select>
            <span id="rCustom" style="display:${state.preset === "custom" ? "contents" : "none"}">
              <input class="input" type="date" id="rFrom" value="${state.from}" aria-label="From date">
              <input class="input" type="date" id="rTo" value="${state.to}" aria-label="To date">
            </span>
            <div class="search-input grow">${icon("search")}<label class="sr-only" for="rSearch">Filter</label>
              <input class="input" id="rSearch" type="search" placeholder="Filter by customer or invoice" value="${state.search}"></div>
          </div>
          <div class="actions">
            <button type="button" class="btn btn-secondary btn-sm" data-export="csv">${icon("download", "icon-sm")}CSV</button>
            <button type="button" class="btn btn-secondary btn-sm" data-export="pdf">${icon("download", "icon-sm")}PDF</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="print">${icon("printer", "icon-sm")}Print</button>
          </div>
        </div>
        <div id="reportOutput">${skeletonRows(6)}</div>
      </section>
    </div>`
  );

  const output = $("#reportOutput", root);
  let controller;
  const params = () => ({ from: state.from, to: state.to, search: state.search });

  const load = async () => {
    controller?.abort();
    controller = new AbortController();
    replaceQuery({ type: state.type, preset: state.preset, ...(state.preset === "custom" ? { from: state.from, to: state.to } : {}), search: state.search });
    output.style.opacity = "0.6";
    try {
      const report = await api(`/reports/${state.type}`, { query: params(), signal: controller.signal });
      if (!isCurrent()) return;
      const currency = report.meta.currency;
      // In the tax summary, hide tax columns that are zero throughout (CSV/PDF keep every column).
      if (report.key === "tax-summary") {
        const zero = (value) => !core.toUnits(value);
        report.columns = report.columns.filter(
          (c) => !["cgst", "sgst", "igst", "other_tax"].includes(c.key) || !(report.rows.every((row) => zero(row[c.key])) && zero(report.totals?.[c.key]))
        );
      }
      const period = report.meta.ignores_range ? `As of ${date(report.meta.today)} (all dates)` : `${date(report.meta.from)} – ${date(report.meta.to)}`;
      mount(
        output,
        html`<div class="card-body" style="padding-bottom:8px">
            <h2>${report.title}</h2>
            <p class="muted small" style="margin-top:2px">${store.business?.name || ""} · ${period} · Amounts in ${currency}</p>
            <div class="callout" style="margin-top:12px">${icon("info", "icon-sm")}<span>${report.note}</span></div>
          </div>
          ${report.rows.length
            ? html`<div class="table-wrap"><table class="table table-compact nowrap">
                <thead><tr>${report.columns.map((c) => html`<th class="${["money", "number", "percent"].includes(c.type) ? "num" : ""}">${c.label}</th>`)}</tr></thead>
                <tbody>${report.rows.map(
                  (row) => html`<tr>${report.columns.map((c) => html`<td class="${["money", "number", "percent"].includes(c.type) ? "num" : ""}">${cell(row[c.key], c.type, currency)}</td>`)}</tr>`
                )}</tbody>
                ${report.totals
                  ? html`<tfoot><tr>${report.columns.map(
                      (c, i) => html`<td class="${["money", "number", "percent"].includes(c.type) ? "num" : ""}">${i === 0 ? "Total" : report.totals[c.key] !== undefined ? cell(report.totals[c.key], c.type, currency) : ""}</td>`
                    )}</tr></tfoot>`
                  : ""}
              </table></div>`
            : emptyState({ iconName: "chart", title: "No records for this period", text: "Try a wider date range or clear the filter." })}`
      );
    } catch (error) {
      if (error.name !== "AbortError") {
        toastError(error);
        mount(output, emptyState({ iconName: "alert", title: "Couldn't run this report", text: error.message }));
      }
    } finally {
      output.style.opacity = "1";
    }
  };

  on(root, "click", "[data-type]", (tab) => {
    state.type = tab.dataset.type;
    root.querySelectorAll("[data-type]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    load();
  });
  $("#rPreset", root).addEventListener("change", (event) => {
    state.preset = event.target.value;
    $("#rCustom", root).style.display = state.preset === "custom" ? "contents" : "none";
    if (state.preset !== "custom") {
      Object.assign(state, presetList.find((p) => p.value === state.preset));
      load();
    }
  });
  ["#rFrom", "#rTo"].forEach((id) =>
    $(id, root).addEventListener("change", () => {
      state.from = $("#rFrom", root).value;
      state.to = $("#rTo", root).value;
      if (state.from && state.to && state.from <= state.to) load();
    })
  );
  $("#rSearch", root).addEventListener("input", debounce((e) => { state.search = e.target.value.trim(); load(); }, 300));
  on(root, "click", "[data-export]", (button) => {
    const format = button.dataset.export;
    const qs = new URLSearchParams({ ...params(), format });
    withBusy(button, () => download(`/reports/${state.type}?${qs}`, `${state.type}.${format}`)).catch(toastError);
  });
  on(root, "click", "[data-action='print']", () => window.print());

  await load();
}
