/** Error carrying the server's field-level validation details. */
export class ApiError extends Error {
  constructor(message, { status, errors, code, data } = {}) {
    super(message);
    this.status = status;
    this.errors = errors || [];
    this.code = code;
    this.data = data || {};
  }
}

let onUnauthorized = () => {
  window.location.href = "/";
};

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/**
 * Call the JSON API. Every request carries X-Requested-With, which the server
 * requires for state-changing requests (CSRF protection).
 */
export async function api(path, { method = "GET", body, query, signal, allowUnauthorized = false } = {}) {
  let url = `/api${path}`;
  if (query) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") params.set(key, value);
    });
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  const headers = { "X-Requested-With": "fetch", Accept: "application/json" };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, { method, headers, body: payload, credentials: "same-origin", signal });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("Can't reach the server. Check your connection and try again.", { status: 0 });
  }

  if (response.status === 401 && !allowUnauthorized) {
    onUnauthorized();
    throw new ApiError("Your session has ended. Please sign in again.", { status: 401 });
  }
  if (response.status === 204) return null;

  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    throw new ApiError(data.error || `Request failed (${response.status})`, {
      status: response.status,
      errors: data.errors,
      code: data.code,
      data,
    });
  }
  return data;
}

/** Download a file from an authenticated endpoint (PDF, CSV). */
export async function download(path, fallbackName) {
  const response = await fetch(`/api${path}`, { headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" });
  if (response.status === 401) {
    onUnauthorized();
    return;
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || "Download failed", { status: response.status });
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = match ? match[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}
