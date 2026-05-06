const app = document.getElementById("app");
const toast = document.getElementById("toast");

const state = {
  user: null,
  page: "dashboard",
  invoices: [],
  customers: [],
  business: null,
  currentInvoice: null,
};

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

function showToast(message, type = "default") {
  toast.textContent = message;
  toast.style.background = type === "error" ? "#b91c1c" : "#111827";
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  });

  if (response.status === 401) {
    if (options.redirectOnUnauthorized === false) return null;
    window.location.href = "/";
    return null;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Request failed");
  }

  if (response.status === 204) return null;
  return response.json();
}

function statusPill(status) {
  return `<span class="status ${status}">${status}</span>`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function setPage(page) {
  state.page = page;
  history.pushState(null, "", `/dashboard${page === "dashboard" ? "" : `#${page}`}`);
  renderApp();
}

function currentPageFromUrl() {
  const hash = window.location.hash.replace("#", "");
  return hash || "dashboard";
}

async function init() {
  try {
    const me = await api("/auth/me", { redirectOnUnauthorized: false });
    state.user = me?.user;
    state.page = currentPageFromUrl();
    if (state.user) {
      renderShell();
    } else {
      renderLogin();
    }
  } catch (error) {
    renderLogin();
  }
}

function renderLogin() {
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-card">
        <div class="login-hero">
          <div class="brand"><span class="brand-mark">IS</span><span>Invoice Studio</span></div>
          <div>
            <h1>Invoice Studio</h1>
            <p>Premium invoice management for founders, consultants, agencies, and modern finance teams.</p>
          </div>
          <div class="metric-strip">
            <div class="mini-metric"><strong>PDF</strong><span>Print-ready invoices</span></div>
            <div class="mini-metric"><strong>GST</strong><span>Business details</span></div>
            <div class="mini-metric"><strong>Pay</strong><span>Payment tracking</span></div>
          </div>
        </div>
        <div class="login-panel">
          <span class="eyebrow">Secure workspace</span>
          <h2>Sign in to manage invoices.</h2>
          <p class="muted">Google authentication is connected. Your dashboard, customers, invoices, PDFs, and payment records stay protected behind your account.</p>
          <button class="google-btn" onclick="window.location.href='/auth/google'">Continue with Google</button>
        </div>
      </section>
    </main>
  `;
}

function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><span class="brand-mark">IS</span><span>Invoice Studio</span></div>
        <nav class="nav">
          ${navButton("dashboard", "Dashboard")}
          ${navButton("invoices", "Invoices")}
          ${navButton("create-invoice", "Create Invoice")}
          ${navButton("customers", "Customers")}
          ${navButton("business", "Business Settings")}
          ${navButton("profile", "Profile")}
        </nav>
        <div class="sidebar-footer">
          <a class="secondary-btn" href="/logout" style="width:100%">Sign out</a>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <button class="icon-btn mobile-menu" onclick="toggleSidebar()">Menu</button>
          <div class="searchbar"><input id="globalSearch" placeholder="Search invoices or customers" onkeydown="globalSearch(event)"></div>
          <div class="row-actions">
            <button class="primary-btn" onclick="setPage('create-invoice')">New Invoice</button>
            <img class="avatar" src="${state.user.avatar_url || ""}" alt="${state.user.name}">
          </div>
        </header>
        <section class="content" id="content"></section>
      </main>
    </div>
  `;
  renderApp();
}

function navButton(page, label) {
  return `<button class="nav-link ${state.page === page ? "active" : ""}" data-page="${page}" onclick="setPage('${page}')">${label}</button>`;
}

function toggleSidebar() {
  document.getElementById("sidebar")?.classList.toggle("open");
}

function globalSearch(event) {
  if (event.key !== "Enter") return;
  const value = event.target.value.trim();
  if (!value) return;
  if (state.page === "customers") loadCustomers(value);
  else {
    setPage("invoices");
    setTimeout(() => {
      const search = document.getElementById("invoiceSearch");
      if (search) {
        search.value = value;
        loadInvoices();
      }
    }, 40);
  }
}

function renderApp() {
  if (!state.user) return renderLogin();
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === state.page);
  });

  if (state.page.startsWith("invoice/")) return renderInvoiceDetail(state.page.split("/")[1]);

  const views = {
    dashboard: renderDashboard,
    invoices: renderInvoices,
    "create-invoice": () => renderInvoiceForm(),
    customers: renderCustomers,
    business: renderBusiness,
    profile: renderProfile,
  };

  (views[state.page] || renderDashboard)();
  document.getElementById("sidebar")?.classList.remove("open");
}

function content(html) {
  document.getElementById("content").innerHTML = html;
}

async function renderDashboard() {
  content(`<div class="loading-screen"><div><div class="loader"></div><p class="muted">Loading dashboard</p></div></div>`);
  try {
    const data = await api("/dashboard/stats");
    const stats = data.stats || {};
    const max = Math.max(...data.monthly.map((m) => Number(m.total)), 1);
    content(`
      <div class="page-head">
        <div class="page-title">
          <span class="eyebrow">Overview</span>
          <h1>Dashboard</h1>
          <p class="muted">A clean view of revenue, invoice status, and recent activity.</p>
        </div>
        <button class="primary-btn" onclick="setPage('create-invoice')">Create Invoice</button>
      </div>
      <div class="grid stats-grid">
        ${statCard("Total invoices", stats.total_invoices || 0)}
        ${statCard("Paid invoices", stats.paid_invoices || 0)}
        ${statCard("Pending invoices", stats.pending_invoices || 0)}
        ${statCard("Revenue", money.format(stats.revenue || 0))}
      </div>
      <div class="grid two-col">
        <section class="card"><div class="card-inner">
          <div class="page-head"><h2>Monthly analytics</h2><span class="muted">Last 12 months</span></div>
          <div class="chart">
            ${(data.monthly.length ? data.monthly : [{ month: "Now", total: 0 }]).map((item) => `
              <div class="bar-wrap">
                <div class="bar" title="${money.format(item.total)}" style="height:${Math.max((Number(item.total) / max) * 220, 8)}px"></div>
                <span>${item.month}</span>
              </div>
            `).join("")}
          </div>
        </div></section>
        <section class="card"><div class="card-inner">
          <div class="page-head"><h2>Recent invoices</h2><button class="ghost-btn" onclick="setPage('invoices')">View all</button></div>
          ${data.recent.length ? invoiceList(data.recent, true) : empty("No invoices yet. Create your first polished invoice.")}
        </div></section>
      </div>
    `);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function statCard(label, value) {
  return `<section class="card stat-card"><span>${label}</span><strong>${value}</strong></section>`;
}

function invoiceList(invoices, compact = false) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Invoice</th><th>Customer</th><th>Status</th>${compact ? "" : "<th>Issue</th><th>Due</th>"}<th>Total</th><th></th></tr></thead>
        <tbody>
          ${invoices.map((invoice) => `
            <tr>
              <td><strong>${invoice.invoice_number}</strong></td>
              <td>${invoice.customer_name || "No customer"}</td>
              <td>${statusPill(invoice.status)}</td>
              ${compact ? "" : `<td>${formatDate(invoice.issue_date)}</td><td>${formatDate(invoice.due_date)}</td>`}
              <td><strong>${money.format(invoice.total || 0)}</strong></td>
              <td class="row-actions">
                <button class="ghost-btn" onclick="setPage('invoice/${invoice.id}')">View</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function renderInvoices() {
  content(`
    <div class="page-head">
      <div class="page-title">
        <span class="eyebrow">Billing</span>
        <h1>Invoices</h1>
        <p class="muted">Search, filter, edit, export, and track invoice status.</p>
      </div>
      <button class="primary-btn" onclick="setPage('create-invoice')">Create Invoice</button>
    </div>
    <div class="filters">
      <div class="field"><input id="invoiceSearch" placeholder="Search invoice or customer" oninput="debouncedLoadInvoices()"></div>
      <div class="field"><select id="invoiceStatus" onchange="loadInvoices()"><option value="">All statuses</option><option value="draft">Draft</option><option value="pending">Pending</option><option value="paid">Paid</option><option value="overdue">Overdue</option></select></div>
      <div class="field"><input id="invoiceFrom" type="date" onchange="loadInvoices()"></div>
      <div class="field"><input id="invoiceTo" type="date" onchange="loadInvoices()"></div>
    </div>
    <section class="card"><div class="card-inner" id="invoiceTable"><div class="loader"></div></div></section>
  `);
  await loadInvoices();
}

let invoiceTimer;
function debouncedLoadInvoices() {
  clearTimeout(invoiceTimer);
  invoiceTimer = setTimeout(loadInvoices, 250);
}

async function loadInvoices() {
  try {
    const params = new URLSearchParams({
      search: document.getElementById("invoiceSearch")?.value || "",
      status: document.getElementById("invoiceStatus")?.value || "",
      from: document.getElementById("invoiceFrom")?.value || "",
      to: document.getElementById("invoiceTo")?.value || "",
    });
    state.invoices = await api(`/invoices?${params}`);
    document.getElementById("invoiceTable").innerHTML = state.invoices.length ? invoiceList(state.invoices) : empty("No invoices match your filters.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function renderInvoiceForm(invoiceId) {
  content(`<div class="loading-screen"><div><div class="loader"></div><p class="muted">Opening invoice editor</p></div></div>`);
  try {
    const [customers, nextNumber, invoice] = await Promise.all([
      api("/customers"),
      api("/invoices/next-number"),
      invoiceId ? api(`/invoices/${invoiceId}`) : Promise.resolve(null),
    ]);
    state.customers = customers;
    state.currentInvoice = invoice;
    const today = new Date().toISOString().slice(0, 10);
    const items = invoice?.items?.length ? invoice.items : [{ description: "", quantity: 1, price: 0, tax_rate: 0 }];
    content(`
      <div class="page-head">
        <div class="page-title">
          <span class="eyebrow">${invoice ? "Edit" : "Create"}</span>
          <h1>${invoice ? "Edit invoice" : "Create invoice"}</h1>
          <p class="muted">Dynamic rows, tax calculation, statuses, and professional PDF export.</p>
        </div>
      </div>
      <form class="grid" onsubmit="saveInvoice(event, ${invoice?.id || "null"})">
        <section class="card"><div class="card-inner grid form-grid">
          ${field("Invoice number", "invoice_number", invoice?.invoice_number || nextNumber.invoice_number)}
          <div class="field"><label>Customer <span class="optional-label">Optional</span></label><select name="customer_id"><option value="">No customer</option>${customers.map((c) => `<option value="${c.id}" ${invoice?.customer_id === c.id ? "selected" : ""}>${c.name}</option>`).join("")}</select></div>
          <div class="field"><label>Status</label><select name="status">${["draft", "pending", "paid", "overdue"].map((s) => `<option value="${s}" ${invoice?.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          ${field("Currency", "currency", invoice?.currency || "INR")}
          ${field("Issue date", "issue_date", (invoice?.issue_date || today).slice(0, 10), "date")}
          ${field("Due date", "due_date", invoice?.due_date ? invoice.due_date.slice(0, 10) : "", "date")}
          <div class="field"><label>Notes</label><textarea name="notes">${invoice?.notes || ""}</textarea></div>
          <div class="field"><label>Terms</label><textarea name="terms">${invoice?.terms || ""}</textarea></div>
        </div></section>
        <section class="card"><div class="card-inner">
          <div class="page-head"><h2>Invoice items</h2><button type="button" class="secondary-btn" onclick="addItemRow()">Add item</button></div>
          <div id="items">${items.map(itemRow).join("")}</div>
          <div class="total-panel">
            <div class="total-line"><span>Subtotal</span><strong id="subtotal">INR 0.00</strong></div>
            <div class="total-line"><span>Tax</span><strong id="taxTotal">INR 0.00</strong></div>
            <div class="total-line grand"><span>Total</span><strong id="grandTotal">INR 0.00</strong></div>
          </div>
        </div></section>
        <div class="form-actions">
          <button type="button" class="secondary-btn" onclick="setPage('invoices')">Cancel</button>
          <button class="primary-btn" type="submit">Save Invoice</button>
        </div>
      </form>
    `);
    calculateTotals();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function field(label, name, value = "", type = "text") {
  return `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${value || ""}"></div>`;
}

function itemRow(item = {}) {
  return `
    <div class="item-row">
      <div class="field"><label>Description</label><input name="description" value="${item.description || ""}" required oninput="calculateTotals()"></div>
      <div class="field"><label>Qty</label><input name="quantity" type="number" min="0" step="0.01" value="${item.quantity || 1}" oninput="calculateTotals()"></div>
      <div class="field"><label>Price</label><input name="price" type="number" min="0" step="0.01" value="${item.price || 0}" oninput="calculateTotals()"></div>
      <div class="field"><label>Tax %</label><input name="tax_rate" type="number" min="0" step="0.01" value="${item.tax_rate || 0}" oninput="calculateTotals()"></div>
      <div class="field"><label>Total</label><input name="line_total" value="${Number(item.line_total || 0).toFixed(2)}" readonly></div>
      <button type="button" class="icon-btn" title="Remove item" onclick="removeItemRow(this)">X</button>
    </div>
  `;
}

function addItemRow() {
  document.getElementById("items").insertAdjacentHTML("beforeend", itemRow());
  calculateTotals();
}

function removeItemRow(button) {
  const rows = document.querySelectorAll(".item-row");
  if (rows.length === 1) return showToast("An invoice needs at least one item.");
  button.closest(".item-row").remove();
  calculateTotals();
}

function calculateTotals() {
  let subtotal = 0;
  let taxTotal = 0;
  document.querySelectorAll(".item-row").forEach((row) => {
    const qty = Number(row.querySelector("[name='quantity']").value) || 0;
    const price = Number(row.querySelector("[name='price']").value) || 0;
    const tax = Number(row.querySelector("[name='tax_rate']").value) || 0;
    const base = qty * price;
    const taxValue = base * (tax / 100);
    subtotal += base;
    taxTotal += taxValue;
    row.querySelector("[name='line_total']").value = (base + taxValue).toFixed(2);
  });
  document.getElementById("subtotal").textContent = money.format(subtotal);
  document.getElementById("taxTotal").textContent = money.format(taxTotal);
  document.getElementById("grandTotal").textContent = money.format(subtotal + taxTotal);
}

async function saveInvoice(event, invoiceId) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  data.items = [...document.querySelectorAll(".item-row")].map((row) => ({
    description: row.querySelector("[name='description']").value,
    quantity: row.querySelector("[name='quantity']").value,
    price: row.querySelector("[name='price']").value,
    tax_rate: row.querySelector("[name='tax_rate']").value,
  }));

  try {
    const saved = await api(invoiceId ? `/invoices/${invoiceId}` : "/invoices", {
      method: invoiceId ? "PUT" : "POST",
      body: JSON.stringify(data),
    });
    showToast("Invoice saved");
    setPage(`invoice/${saved.id}`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function renderInvoiceDetail(id) {
  content(`<div class="loading-screen"><div><div class="loader"></div><p class="muted">Loading invoice</p></div></div>`);
  try {
    const invoice = await api(`/invoices/${id}`);
    state.currentInvoice = invoice;
    content(`
      <div class="page-head">
        <div class="page-title">
          <span class="eyebrow">Invoice details</span>
          <h1>${invoice.invoice_number}</h1>
          <p class="muted">${invoice.customer_name || "Customer"} - ${formatDate(invoice.issue_date)}</p>
        </div>
        <div class="row-actions">
          <button class="secondary-btn" onclick="renderInvoiceForm(${invoice.id})">Edit</button>
          <button class="secondary-btn" onclick="window.location.href='/api/invoices/${invoice.id}/pdf'">Download PDF</button>
          <button class="primary-btn" onclick="markPaid(${invoice.id})">Mark Paid</button>
          <button class="danger-btn" onclick="deleteInvoice(${invoice.id})">Delete</button>
        </div>
      </div>
      <section class="card invoice-paper">
        <div class="detail-header">
          <div><h2>Invoice</h2><p class="muted">${invoice.invoice_number}</p></div>
          <div>${statusPill(invoice.status)}<p><strong>${money.format(invoice.total || 0)}</strong></p></div>
        </div>
        <div class="invoice-parties">
          <div><span class="eyebrow">From</span><h3>${invoice.business_name || "Business"}</h3><p class="muted">${[invoice.business_address, invoice.business_city, invoice.business_state, invoice.business_country].filter(Boolean).join(", ") || "Add business details in settings."}</p></div>
          <div><span class="eyebrow">Bill to</span><h3>${invoice.customer_name || "Customer"}</h3><p class="muted">${[invoice.customer_email, invoice.customer_phone, invoice.customer_address].filter(Boolean).join(" - ")}</p></div>
        </div>
        ${invoiceListItems(invoice.items)}
        <div class="total-panel">
          <div class="total-line"><span>Subtotal</span><strong>${money.format(invoice.subtotal || 0)}</strong></div>
          <div class="total-line"><span>Tax</span><strong>${money.format(invoice.tax_total || 0)}</strong></div>
          <div class="total-line"><span>Paid</span><strong>${money.format(invoice.paid_total || 0)}</strong></div>
          <div class="total-line grand"><span>Total</span><strong>${money.format(invoice.total || 0)}</strong></div>
        </div>
      </section>
      <section class="card" style="margin-top:18px"><div class="card-inner">
        <div class="page-head"><h2>Payment history</h2><button class="secondary-btn" onclick="addPayment(${invoice.id})">Add payment</button></div>
        ${invoice.payments.length ? paymentTable(invoice.payments) : empty("No payment records yet.")}
      </div></section>
    `);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function invoiceListItems(items) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Description</th><th>Qty</th><th>Price</th><th>Tax</th><th>Total</th></tr></thead>
        <tbody>${items.map((item) => `<tr><td>${item.description}</td><td>${item.quantity}</td><td>${money.format(item.price)}</td><td>${item.tax_rate}%</td><td><strong>${money.format(item.line_total)}</strong></td></tr>`).join("")}</tbody>
      </table>
    </div>
  `;
}

function paymentTable(payments) {
  return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Transaction</th></tr></thead><tbody>${payments.map((p) => `<tr><td>${formatDate(p.paid_at)}</td><td>${money.format(p.amount)}</td><td>${p.method || "-"}</td><td>${p.transaction_id || "-"}</td></tr>`).join("")}</tbody></table></div>`;
}

async function markPaid(id) {
  try {
    await api(`/invoices/${id}/mark-paid`, { method: "POST" });
    showToast("Invoice marked paid");
    renderInvoiceDetail(id);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function addPayment(id) {
  const amount = prompt("Payment amount");
  if (!amount) return;
  const method = prompt("Payment method", "Bank transfer") || "Manual";
  try {
    await api(`/invoices/${id}/payments`, {
      method: "POST",
      body: JSON.stringify({ amount, method }),
    });
    showToast("Payment recorded");
    renderInvoiceDetail(id);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteInvoice(id) {
  if (!confirm("Delete this invoice?")) return;
  try {
    await api(`/invoices/${id}`, { method: "DELETE" });
    showToast("Invoice deleted");
    setPage("invoices");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function renderCustomers() {
  content(`
    <div class="page-head">
      <div class="page-title">
        <span class="eyebrow">Relationships</span>
        <h1>Customers</h1>
        <p class="muted">Create customer profiles for faster billing and cleaner records.</p>
      </div>
      <button class="primary-btn" onclick="customerForm()">Add Customer</button>
    </div>
    <div class="filters" style="grid-template-columns:1fr">
      <div class="field"><input id="customerSearch" placeholder="Search customers" oninput="debouncedCustomers()"></div>
    </div>
    <section class="card"><div class="card-inner" id="customerArea"><div class="loader"></div></div></section>
  `);
  await loadCustomers();
}

let customerTimer;
function debouncedCustomers() {
  clearTimeout(customerTimer);
  customerTimer = setTimeout(() => loadCustomers(), 250);
}

async function loadCustomers(searchValue) {
  try {
    const search = searchValue ?? document.getElementById("customerSearch")?.value ?? "";
    state.customers = await api(`/customers?search=${encodeURIComponent(search)}`);
    document.getElementById("customerArea").innerHTML = state.customers.length ? customerTable(state.customers) : empty("No customers yet.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function customerTable(customers) {
  return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>GST</th><th></th></tr></thead><tbody>${customers.map((c) => `<tr><td><strong>${c.name}</strong></td><td>${c.email || "-"}</td><td>${c.phone || "-"}</td><td>${c.gst_number || "-"}</td><td class="row-actions"><button class="ghost-btn" onclick="customerFormById(${c.id})">Edit</button><button class="danger-btn" onclick="deleteCustomer(${c.id})">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
}

function customerFormById(id) {
  const customer = state.customers.find((item) => Number(item.id) === Number(id));
  if (customer) customerForm(customer);
}

function customerForm(customer = null) {
  content(`
    <div class="page-head"><div class="page-title"><span class="eyebrow">${customer ? "Edit" : "Create"}</span><h1>${customer ? "Edit customer" : "Add customer"}</h1></div></div>
    <form class="grid" onsubmit="saveCustomer(event, ${customer?.id || "null"})">
      <section class="card"><div class="card-inner grid form-grid">
        ${field("Name", "name", customer?.name || "")}
        ${field("Email", "email", customer?.email || "", "email")}
        ${field("Phone", "phone", customer?.phone || "")}
        ${field("GST number", "gst_number", customer?.gst_number || "")}
        ${field("City", "city", customer?.city || "")}
        ${field("State", "state", customer?.state || "")}
        ${field("Postal code", "postal_code", customer?.postal_code || "")}
        ${field("Country", "country", customer?.country || "")}
        <div class="field" style="grid-column:1/-1"><label>Address</label><textarea name="address">${customer?.address || ""}</textarea></div>
      </div></section>
      <div class="form-actions"><button type="button" class="secondary-btn" onclick="setPage('customers')">Cancel</button><button class="primary-btn">Save Customer</button></div>
    </form>
  `);
}

async function saveCustomer(event, id) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  try {
    await api(id ? `/customers/${id}` : "/customers", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data),
    });
    showToast("Customer saved");
    setPage("customers");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteCustomer(id) {
  if (!confirm("Delete this customer?")) return;
  try {
    await api(`/customers/${id}`, { method: "DELETE" });
    showToast("Customer deleted");
    loadCustomers();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function renderBusiness() {
  content(`<div class="loading-screen"><div><div class="loader"></div><p class="muted">Loading business settings</p></div></div>`);
  try {
    const business = await api("/business");
    state.business = business;
    content(`
      <div class="page-head"><div class="page-title"><span class="eyebrow">Settings</span><h1>Business Settings</h1><p class="muted">Business identity, GST, contact details, invoice terms, and logo.</p></div></div>
      <form class="grid" onsubmit="saveBusiness(event)">
        <section class="card"><div class="card-inner">
          <div class="page-head">
            <div><h2>Logo</h2><p class="muted">Upload a PNG or JPG logo for invoices.</p></div>
            ${business.logo_url ? `<img class="avatar" src="${business.logo_url}" alt="Business logo">` : ""}
          </div>
          <div class="field"><input type="file" id="logoFile" accept="image/*" onchange="uploadLogo()"></div>
        </div></section>
        <section class="card"><div class="card-inner grid form-grid">
          ${field("Business name", "name", business.name || "")}
          ${field("GST number", "gst_number", business.gst_number || "")}
          ${field("Email", "email", business.email || "", "email")}
          ${field("Phone", "phone", business.phone || "")}
          ${field("Website", "website", business.website || "")}
          ${field("City", "city", business.city || "")}
          ${field("State", "state", business.state || "")}
          ${field("Postal code", "postal_code", business.postal_code || "")}
          ${field("Country", "country", business.country || "")}
          <div class="field" style="grid-column:1/-1"><label>Address</label><textarea name="address">${business.address || ""}</textarea></div>
          <div class="field"><label>Bank details</label><textarea name="bank_details">${business.bank_details || ""}</textarea></div>
          <div class="field"><label>Default terms</label><textarea name="terms">${business.terms || ""}</textarea></div>
        </div></section>
        <div class="form-actions"><span></span><button class="primary-btn">Save Settings</button></div>
      </form>
    `);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveBusiness(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  try {
    await api("/business", { method: "PUT", body: JSON.stringify(data) });
    showToast("Business settings saved");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function uploadLogo() {
  const file = document.getElementById("logoFile").files[0];
  if (!file) return;
  const data = new FormData();
  data.append("logo", file);
  try {
    await api("/business/logo", { method: "POST", body: data });
    showToast("Logo uploaded");
    renderBusiness();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderProfile() {
  content(`
    <div class="page-head"><div class="page-title"><span class="eyebrow">Account</span><h1>Profile Settings</h1><p class="muted">Your Google-authenticated workspace identity.</p></div></div>
    <section class="card"><div class="card-inner grid form-grid">
      <div class="field"><label>Name</label><input value="${state.user.name}" readonly></div>
      <div class="field"><label>Email</label><input value="${state.user.email}" readonly></div>
      <div class="field"><label>User ID</label><input value="${state.user.id}" readonly></div>
      <div class="field"><label>Authentication</label><input value="Google OAuth" readonly></div>
    </div></section>
  `);
}

function empty(message) {
  return `<div class="empty">${message}</div>`;
}

window.addEventListener("popstate", () => {
  state.page = currentPageFromUrl();
  renderApp();
});

init();
