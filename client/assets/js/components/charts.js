import { html, mount } from "../lib/dom.js";
import { compactMoney, money, date, monthLabel } from "../lib/format.js";

const core = window.InvoiceCore;
const SVG_NS = "http://www.w3.org/2000/svg";

const SERIES = [
  { key: "invoiced", label: "Invoiced", color: "#2a78d6" },
  { key: "collected", label: "Collected", color: "#eb6834" },
];

function niceMax(value) {
  if (value <= 0) return 100000; // ₹1,000 in paise, so an empty chart still has a scale.
  const rough = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  return step * 4;
}

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

/** Column path with 4px rounded data-end, square at the baseline. */
function columnPath(x, y, width, height) {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function bucketLabel(bucket, granularity, long = false) {
  if (granularity === "month") return long ? monthLabel(bucket) : monthLabel(bucket);
  const [, m, d] = bucket.split("-").map(Number);
  return long ? date(bucket) : `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}`;
}

/**
 * Grouped column chart of invoiced vs collected per bucket. Re-renders on
 * resize; includes a hover/focus tooltip and an accessible table view.
 */
export function revenueChart(container, { series, granularity, currency = "INR" }) {
  const rows = series.map((row) => ({
    bucket: row.bucket,
    invoiced: core.toUnits(row.invoiced),
    collected: core.toUnits(row.collected),
    invoices: row.invoices,
  }));
  let showTable = false;

  mount(
    container,
    html`<div class="chart-toolbar" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
        <div class="chart-legend" aria-label="Legend">
          ${SERIES.map((s) => html`<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</span>`)}
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-chart-toggle aria-pressed="false">View as table</button>
      </div>
      <div class="chart" data-chart-area></div>`
  );
  const area = container.querySelector("[data-chart-area]");
  const toggle = container.querySelector("[data-chart-toggle]");

  const renderTable = () => {
    mount(
      area,
      html`<div class="table-wrap"><table class="table table-compact">
        <thead><tr><th>${granularity === "month" ? "Month" : "Date"}</th><th class="num">Invoices</th><th class="num">Invoiced</th><th class="num">Collected</th></tr></thead>
        <tbody>${rows.map(
          (row) => html`<tr><td>${bucketLabel(row.bucket, granularity, true)}</td><td class="num">${row.invoices}</td>
            <td class="num">${core.formatMoney(row.invoiced, currency)}</td><td class="num">${core.formatMoney(row.collected, currency)}</td></tr>`
        )}</tbody>
      </table></div>`
    );
  };

  const renderSvg = () => {
    const width = Math.max(area.clientWidth || 600, 280);
    const height = 260;
    const margin = { top: 12, right: 8, bottom: 28, left: 58 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const max = niceMax(Math.max(...rows.map((r) => Math.max(r.invoiced, r.collected)), 0));
    const yFor = (value) => margin.top + plotH - (value / max) * plotH;

    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Invoiced and collected amounts over time" });
    for (let i = 0; i <= 4; i += 1) {
      const value = (max / 4) * i;
      const y = yFor(value);
      svg.appendChild(el("line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: i === 0 ? "axis-line" : "grid-line" }));
      const label = el("text", { x: margin.left - 8, y: y + 4, "text-anchor": "end", class: "tick" });
      label.textContent = compactMoney(core.unitsToString(Math.round(value)), currency);
      svg.appendChild(label);
    }

    const band = plotW / rows.length;
    const gap = 2;
    const barW = Math.max(2, Math.min(24, (band * 0.7 - gap) / 2));
    const labelEvery = Math.ceil(rows.length / Math.max(1, Math.floor(plotW / 64)));

    rows.forEach((row, i) => {
      const center = margin.left + band * i + band / 2;
      SERIES.forEach((s, j) => {
        const value = row[s.key];
        if (value <= 0) return;
        const x = center - barW - gap / 2 + j * (barW + gap);
        const y = yFor(value);
        const h = Math.max(1, margin.top + plotH - y);
        svg.appendChild(el("path", { d: columnPath(x, margin.top + plotH - h, barW, h), fill: s.color }));
      });
      if (i % labelEvery === 0) {
        const label = el("text", { x: center, y: height - 8, "text-anchor": "middle", class: "tick" });
        label.textContent = bucketLabel(row.bucket, granularity);
        svg.appendChild(label);
      }
      const hit = el("rect", {
        x: margin.left + band * i,
        y: margin.top,
        width: band,
        height: plotH,
        class: "hit",
        tabindex: 0,
        "data-index": i,
        "aria-label": `${bucketLabel(row.bucket, granularity, true)}: invoiced ${core.formatMoney(row.invoiced, currency)}, collected ${core.formatMoney(row.collected, currency)}`,
      });
      svg.appendChild(hit);
    });

    area.replaceChildren(svg);
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    area.appendChild(tooltip);

    const show = (index, anchorX) => {
      const row = rows[index];
      tooltip.replaceChildren();
      const title = document.createElement("div");
      title.className = "tt-title";
      title.textContent = bucketLabel(row.bucket, granularity, true);
      tooltip.appendChild(title);
      SERIES.forEach((s) => {
        const line = document.createElement("div");
        line.className = "tt-row";
        const key = document.createElement("span");
        key.className = "tt-key";
        key.style.background = s.color;
        const value = document.createElement("span");
        value.className = "tt-value";
        value.textContent = core.formatMoney(row[s.key], currency);
        const label = document.createElement("span");
        label.className = "tt-label";
        label.textContent = s.label;
        line.append(key, value, label);
        tooltip.appendChild(line);
      });
      tooltip.hidden = false;
      const scale = area.clientWidth / width;
      const left = Math.min(Math.max(anchorX * scale - tooltip.offsetWidth / 2, 0), area.clientWidth - tooltip.offsetWidth);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = "0px";
    };
    const hide = () => {
      tooltip.hidden = true;
    };
    svg.querySelectorAll(".hit").forEach((hit) => {
      const index = Number(hit.dataset.index);
      const anchor = margin.left + band * index + band / 2;
      hit.addEventListener("pointerenter", () => show(index, anchor));
      hit.addEventListener("focus", () => show(index, anchor));
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("blur", hide);
    });
  };

  const render = () => (showTable ? renderTable() : renderSvg());
  toggle.addEventListener("click", () => {
    showTable = !showTable;
    toggle.setAttribute("aria-pressed", String(showTable));
    toggle.textContent = showTable ? "View as chart" : "View as table";
    render();
  });

  let lastWidth = 0;
  const observer = new ResizeObserver(() => {
    if (showTable || !area.isConnected) return;
    const width = area.clientWidth;
    if (Math.abs(width - lastWidth) > 4) {
      lastWidth = width;
      renderSvg();
    }
  });
  observer.observe(area);
  render();
  return { destroy: () => observer.disconnect() };
}

export { money };
