import { api } from "./api.js";

/** Session-wide state shared by pages. */
export const store = {
  user: null,
  business: null,
  today: null,
  counts: { invoices: 0, customers: 0 },
  setup: {},
  settings: null,
};

export async function loadBootstrap() {
  const data = await api("/bootstrap", { allowUnauthorized: true });
  Object.assign(store, data);
  return data;
}

/** Full business settings (bank, UPI, signatory), cached until settings change. */
export async function getSettings({ refresh = false } = {}) {
  if (!store.settings || refresh) store.settings = await api("/business");
  return store.settings;
}

export function invalidateSettings() {
  store.settings = null;
}
