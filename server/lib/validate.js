/*
 * Small declarative validator for request bodies. Each field spec returns the
 * cleaned value; problems are collected so the client can show inline errors.
 */
const core = require("../../shared/invoice-core");
const { badRequest } = require("./http");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^[+0-9 ()-]{6,20}$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_PATTERN = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function text(max, options = {}) {
  return (value, label) => {
    const result = value === null || value === undefined ? "" : String(value).trim();
    if (options.required && !result) return { error: `${label} is required.` };
    if (result.length > max) return { error: `${label} must be ${max} characters or fewer.` };
    return { value: options.upper ? result.toUpperCase() : result };
  };
}

function pattern(max, regex, message, options = {}) {
  const base = text(max, options);
  return (value, label) => {
    const result = base(value, label);
    if (result.error || !result.value) return result;
    return regex.test(result.value) ? result : { error: message || `${label} is not valid.` };
  };
}

const rules = {
  text,
  email: (options) => pattern(254, EMAIL_PATTERN, "Enter a valid email address.", options),
  phone: (options) => pattern(20, PHONE_PATTERN, "Enter a valid phone number (digits, spaces, +, - only).", options),
  url: () => (value, label) => {
    const result = text(200)(value, label);
    if (!result.value) return result;
    const candidate = /^https?:\/\//i.test(result.value) ? result.value : `https://${result.value}`;
    try {
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes(".")) throw new Error("bad");
      return { value: result.value };
    } catch (error) {
      return { error: "Enter a valid website address." };
    }
  },
  gstin: () => (value) => {
    const result = String(value || "").trim().toUpperCase();
    const error = core.gstinError(result);
    return error ? { error } : { value: result };
  },
  pan: () => (value) => {
    const result = String(value || "").trim().toUpperCase();
    const error = core.panError(result);
    return error ? { error } : { value: result };
  },
  stateCode: () => (value) => {
    const result = String(value || "").trim();
    if (!result) return { value: "" };
    return core.stateByCode(result) ? { value: result } : { error: "Choose a state from the list." };
  },
  ifsc: () => pattern(11, IFSC_PATTERN, "IFSC must be 11 characters (for example HDFC0001234).", { upper: true }),
  upi: () => pattern(320, UPI_PATTERN, "Enter a valid UPI ID (for example yourname@okbank)."),
  color: () => (value) => {
    const result = String(value || "").trim();
    if (!result) return { value: "#2563eb" };
    return HEX_COLOR_PATTERN.test(result) ? { value: result.toLowerCase() } : { error: "Choose a valid colour." };
  },
  oneOf: (allowed, fallback) => (value, label) => {
    if ((value === undefined || value === null || value === "") && fallback !== undefined) return { value: fallback };
    return allowed.includes(value) ? { value } : { error: `${label} is not a valid option.` };
  },
  bool: () => (value) => ({ value: value === true || value === "true" || value === "on" || value === 1 || value === "1" }),
  int: (min, max) => (value, label) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      return { error: `${label} must be a whole number between ${min} and ${max}.` };
    }
    return { value: number };
  },
  date: (options = {}) => (value, label) => {
    const result = String(value || "").trim();
    if (!result) return options.required ? { error: `${label} is required.` } : { value: null };
    return core.isIsoDate(result) ? { value: result } : { error: `${label} must be a valid date.` };
  },
  rate: () => (value, label) => {
    try {
      return { value: core.unitsToString(core.parseDecimal(value, 2, { label, defaultUnits: 0, max: 10000, maxMessage: `${label} cannot exceed 100%.` })) };
    } catch (error) {
      return { error: error.message };
    }
  },
};

/**
 * Validate body against { field: [label, rule] }. Throws 422 with all errors.
 * Fields missing from the body are only validated when `partial` is false.
 */
function validateBody(body, schema, { partial = false } = {}) {
  const source = body && typeof body === "object" ? body : {};
  const value = {};
  const errors = [];
  for (const [field, [label, rule]] of Object.entries(schema)) {
    if (partial && !(field in source)) continue;
    const result = rule(source[field], label);
    if (result.error) errors.push({ field, message: result.error });
    else value[field] = result.value;
  }
  if (errors.length) throw badRequest(errors);
  return value;
}

module.exports = { rules, validateBody };
