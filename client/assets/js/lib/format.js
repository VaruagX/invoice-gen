const core = window.InvoiceCore;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function money(value, currency = "INR") {
  return core.formatAmount(value ?? 0, currency);
}

export function moneyUnits(units, currency = "INR") {
  return core.formatMoney(units, currency);
}

const compactFormatters = {};
export function compactMoney(value, currency = "INR") {
  const key = currency;
  if (!compactFormatters[key]) {
    try {
      compactFormatters[key] = new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 1,
      });
    } catch (error) {
      compactFormatters[key] = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
    }
  }
  return compactFormatters[key].format(core.toUnits(value) / 100);
}

/** "2026-10-15" or ISO timestamp → "15 Oct 2026". */
export function date(value) {
  if (!value) return "—";
  const text = typeof value === "string" ? value : new Date(value).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  const dt = new Date(text);
  return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function monthLabel(isoDate, withYear = true) {
  const [y, m] = isoDate.slice(0, 7).split("-").map(Number);
  return withYear ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : MONTHS[m - 1];
}

export function dateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function relativeTime(value) {
  const then = new Date(value).getTime();
  const diff = Math.round((Date.now() - then) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return date(value);
}

export function number(value) {
  return Number(value || 0).toLocaleString("en-IN");
}

export function plural(count, word, pluralWord) {
  return `${number(count)} ${count === 1 ? word : pluralWord || `${word}s`}`;
}

export function percentChange(current, previous) {
  const c = core.toUnits(current);
  const p = core.toUnits(previous);
  if (!p) return null;
  return ((c - p) / p) * 100;
}

export const statusLabel = core.statusLabel;
export const methodLabel = core.paymentMethodLabel;
