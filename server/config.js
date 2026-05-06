const DEFAULT_PORT = 8000;

const port = Number(process.env.PORT || DEFAULT_PORT);
const isProduction = process.env.NODE_ENV === "production";
const defaultLocalAppUrl = `http://localhost:${port}`;

function trimTrailingSlash(value) {
  return value ? value.replace(/\/+$/, "") : value;
}

function normalizeUrl(value, name) {
  if (!value) return value;

  try {
    return trimTrailingSlash(new URL(value).toString());
  } catch (error) {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
}

function resolveAppUrl() {
  const configuredUrl = normalizeUrl(
    process.env.APP_URL || process.env.RENDER_EXTERNAL_URL,
    "APP_URL"
  );


  if (configuredUrl) {
    return configuredUrl;
  }

  if (process.env.GOOGLE_CALLBACK_URL) {
    return new URL(resolveGoogleCallbackUrl()).origin;
  }

  if (isProduction) {
    throw new Error(
      "APP_URL or GOOGLE_CALLBACK_URL must be set when NODE_ENV=production."
    );
  }

  return defaultLocalAppUrl;
}

function resolveGoogleCallbackUrl() {
  // Always prefer the explicit callback URL if provided.
  // This eliminates redirect_uri_mismatch caused by wrong origin detection.
  if (process.env.GOOGLE_CALLBACK_URL) {
    return normalizeUrl(
      process.env.GOOGLE_CALLBACK_URL,
      "GOOGLE_CALLBACK_URL"
    );
  }

  // Fallback: derive from app origin.
  return `${resolveAppUrl()}/auth/google/callback`;
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required.`);
  }
}

function validateRequiredConfig() {
  requireEnv("GOOGLE_CLIENT_ID");
  requireEnv("GOOGLE_CLIENT_SECRET");

  if (isProduction) {
    requireEnv("SESSION_SECRET");
  }
}

validateRequiredConfig();

module.exports = {
  appUrl: resolveAppUrl(),
  googleCallbackUrl: resolveGoogleCallbackUrl(),
  isProduction,
  port,
};
