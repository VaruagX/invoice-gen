import { html, $, formValues } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { openModal, toast, confirmDialog } from "../lib/ui.js";

const core = window.InvoiceCore;

export function stateOptions(selected, { placeholder = "Select state" } = {}) {
  return html`<option value="">${placeholder}</option>${core.STATES.map(
    (state) => html`<option value="${state.code}" ${state.code === selected ? "selected" : ""}>${state.name} (${state.code})</option>`
  )}`;
}

/** Add or edit a customer. Resolves the saved customer through onSaved. */
export function openCustomerDialog({ customer = null, onSaved } = {}) {
  const c = customer || { country: "India" };
  const stateCode = c.state_code || core.stateByName(c.state)?.code || "";
  const sameAsBilling = Boolean(c.shipping_address) && c.shipping_address === c.address;

  const submitCustomer = async (body, allowDuplicate) => {
    const payload = Object.assign({}, body, allowDuplicate ? { allow_duplicate: true } : {});
    try {
      return await api(customer ? `/customers/${customer.id}` : "/customers", { method: customer ? "PUT" : "POST", body: payload });
    } catch (error) {
      if (error.code === "DUPLICATE_CUSTOMER" && !allowDuplicate) {
        const match = error.data.duplicates?.[0];
        const proceed = await confirmDialog({
          title: "Possible duplicate customer",
          message: `${match?.name || "A customer"}${match?.email ? ` (${match.email})` : ""} already has the same name, email or GSTIN. Save this customer anyway?`,
          confirmLabel: "Save anyway",
        });
        if (!proceed) return null;
        return submitCustomer(body, true);
      }
      throw error;
    }
  };

  const { dialog } = openModal({
    title: customer ? "Edit customer" : "Add customer",
    description: "Customer details appear on invoices. GSTIN and state decide how GST is applied.",
    wide: true,
    body: html`<div class="form-grid">
      <div class="field">
        <label for="cName">Customer name</label>
        <input class="input" id="cName" name="name" value="${c.name || ""}" maxlength="120" required autocomplete="off">
      </div>
      <div class="field">
        <label for="cCompany">Company <span class="optional">(optional)</span></label>
        <input class="input" id="cCompany" name="company_name" value="${c.company_name || ""}" maxlength="160">
      </div>
      <div class="field">
        <label for="cEmail">Email <span class="optional">(optional)</span></label>
        <input class="input" id="cEmail" name="email" type="email" value="${c.email || ""}" maxlength="254" autocomplete="off">
      </div>
      <div class="field">
        <label for="cPhone">Phone <span class="optional">(optional)</span></label>
        <input class="input" id="cPhone" name="phone" type="tel" value="${c.phone || ""}" maxlength="20" autocomplete="off">
      </div>
      <div class="field">
        <label for="cGstin">GSTIN <span class="optional">(if registered)</span></label>
        <input class="input" id="cGstin" name="gst_number" value="${c.gst_number || ""}" maxlength="15" style="text-transform:uppercase" autocomplete="off" placeholder="27ABCDE1234F1Z5">
      </div>
      <div class="field">
        <label for="cPan">PAN <span class="optional">(optional)</span></label>
        <input class="input" id="cPan" name="pan" value="${c.pan || ""}" maxlength="10" style="text-transform:uppercase" autocomplete="off">
      </div>
      <div class="field">
        <label for="cState">State</label>
        <select class="select" id="cState" name="state_code" data-field="state_code">${stateOptions(stateCode)}</select>
        <span class="hint">Used as the place of supply for GST.</span>
      </div>
      <div class="field">
        <label for="cCity">City</label>
        <input class="input" id="cCity" name="city" value="${c.city || ""}" maxlength="80">
      </div>
      <div class="field">
        <label for="cPin">PIN code</label>
        <input class="input" id="cPin" name="postal_code" value="${c.postal_code || ""}" maxlength="12" inputmode="numeric">
      </div>
      <div class="field">
        <label for="cCountry">Country</label>
        <input class="input" id="cCountry" name="country" value="${c.country || ""}" maxlength="80">
      </div>
      <div class="field span-2">
        <label for="cAddress">Billing address</label>
        <textarea class="textarea" id="cAddress" name="address" rows="2" maxlength="500">${c.address || ""}</textarea>
      </div>
      <div class="field span-2">
        <label class="check"><input type="checkbox" id="cSame" ${sameAsBilling ? "checked" : ""}><span class="check-text">Shipping address is the same as billing</span></label>
        <label for="cShipping" class="sr-only">Shipping address</label>
        <textarea class="textarea" id="cShipping" name="shipping_address" rows="2" maxlength="500" placeholder="Shipping address (optional)" ${sameAsBilling ? "hidden" : ""}>${c.shipping_address || ""}</textarea>
      </div>
      <div class="field span-2">
        <label for="cNotes">Internal notes <span class="optional">(not printed)</span></label>
        <textarea class="textarea" id="cNotes" name="notes" rows="2" maxlength="2000">${c.notes || ""}</textarea>
      </div>
    </div>`,
    footer: html`<button type="button" class="btn btn-secondary" data-close>Cancel</button>
      <button type="submit" class="btn btn-primary" data-busy-label="Saving">${customer ? "Save changes" : "Add customer"}</button>`,
    onSubmit: async (form) => {
      const values = formValues(form);
      if ($("#cSame", form).checked) values.shipping_address = values.address;
      const saved = await submitCustomer(values, false);
      if (!saved) return false;
      toast(customer ? "Customer updated." : `${saved.name} added.`);
      onSaved?.(saved);
      return saved;
    },
  });

  const same = $("#cSame", dialog);
  const shipping = $("#cShipping", dialog);
  same.addEventListener("change", () => {
    shipping.hidden = same.checked;
  });
  // Pre-select the state from a GSTIN's first two digits.
  $("#cGstin", dialog).addEventListener("change", (event) => {
    const code = event.target.value.trim().slice(0, 2);
    const stateSelect = $("#cState", dialog);
    if (!stateSelect.value && core.stateByCode(code)) stateSelect.value = code;
  });
}
