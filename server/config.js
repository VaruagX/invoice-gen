const DEFAULT_PORT = 8000;

const port = Number(process.env.PORT || DEFAULT_PORT);
const isProduction = process.env.NODE_ENV === "production";

function trimTrailingSlash(value) {
  return value ? value.replace(/\/+$/, "") : value;
}

function localAppUrl() {
  return `http://localhost:${port}`;
}

function resolveAppUrl() {
  const configuredUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;

  if (configuredUrl) {
    return trimTrailingSlash(configuredUrl);
  }

  if (process.env.GOOGLE_CALLBACK_URL) {
    return new URL(process.env.GOOGLE_CALLBACK_URL).origin;
  }

  return localAppUrl();
}

function resolveGoogleCallbackUrl() {
  if (process.env.GOOGLE_CALLBACK_URL) {
    return process.env.GOOGLE_CALLBACK_URL;
  }

  return `${resolveAppUrl()}/auth/google/callback`;
}

module.exports = {
  appUrl: resolveAppUrl(),
  googleCallbackUrl: resolveGoogleCallbackUrl(),
  isProduction,
  port,
};
