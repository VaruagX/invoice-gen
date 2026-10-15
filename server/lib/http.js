const core = require("../../shared/invoice-core");

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.expose = true;
    if (extra) Object.assign(this, extra);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ""));
}

/** Wrap an async route handler so rejections reach the error middleware. */
function handle(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Router param validator: invalid ids behave exactly like ids that do not exist. */
function uuidParam(label) {
  return (req, res, next, value) => {
    if (!isUuid(value)) return next(new HttpError(404, `${label} not found`));
    next();
  };
}

function badRequest(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  return new HttpError(422, list[0]?.message || "Please check the highlighted fields.", { errors: list });
}

/** Convert ValidationError → 422 with a field reference. */
function fromValidation(error) {
  if (error instanceof core.ValidationError) {
    return badRequest([{ field: error.field, message: error.message }]);
  }
  return error;
}

function parsePagination(query, { defaultSize = 20, maxSize = 100 } = {}) {
  const page = Math.max(1, Math.min(10000, parseInt(query.page, 10) || 1));
  const pageSize = Math.max(1, Math.min(maxSize, parseInt(query.page_size, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => "\\" + ch);
}

function safeFilename(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

module.exports = {
  HttpError,
  isUuid,
  handle,
  uuidParam,
  badRequest,
  fromValidation,
  parsePagination,
  escapeLike,
  safeFilename,
};
