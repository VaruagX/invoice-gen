import { html, mount, initials } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { store } from "../lib/store.js";
import { date } from "../lib/format.js";

export async function render({ root, setTitle }) {
  setTitle("Profile");
  const user = store.user;
  mount(
    root,
    html`<div class="page-header"><div><h1>Profile</h1><p>Your account and how you sign in.</p></div></div>
    <div class="grid-main-side">
      <section class="card">
        <div class="card-body" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          ${user.avatar_url
            ? html`<img class="avatar" src="${user.avatar_url}" alt="" referrerpolicy="no-referrer" style="width:64px;height:64px">`
            : html`<span class="avatar" style="width:64px;height:64px;font-size:20px">${initials(user.name)}</span>`}
          <div>
            <h2 style="font-size:18px">${user.name}</h2>
            <p class="muted">${user.email}</p>
          </div>
        </div>
        <div class="card-body" style="border-top:1px solid var(--border)">
          <dl class="details-list">
            <dt>Sign-in method</dt><dd>Google account</dd>
            <dt>Member since</dt><dd>${date(user.created_at)}</dd>
            <dt>Business</dt><dd><a href="#/settings">${store.business?.name || "Set up your business"}</a></dd>
          </dl>
        </div>
        <div class="card-footer">
          <span class="muted small">Your name and photo come from your Google account.</span>
          <a class="btn btn-secondary" href="/logout">${icon("logout")}Sign out</a>
        </div>
      </section>
      <section class="card">
        <div class="card-header"><h2>Privacy & security</h2></div>
        <div class="card-body stack-sm">
          <p class="small">${icon("checkCircle", "icon-sm")} Your invoices, customers and payments are only visible to your account.</p>
          <p class="small">${icon("checkCircle", "icon-sm")} Payment records are kept as an audit trail — voided payments stay visible rather than being deleted.</p>
          <p class="small">${icon("info", "icon-sm")} Invoice Studio records payments you enter. It does not collect money or connect to your bank.</p>
        </div>
      </section>
    </div>`
  );
}
