import * as Sentry from "@sentry/node";

let enabled = false;

export function scrubEvent(event) {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }
  delete event.user;
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => {
      if (["query", "redis", "http"].includes(breadcrumb.category)) {
        return { ...breadcrumb, message: "dependency operation", data: undefined };
      }
      return breadcrumb;
    });
  }
  return event;
}

export function initObservability() {
  const dsn = String(process.env.SENTRY_DSN || "").trim();
  if (!dsn) return false;
  const parsedRate = Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.05");
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME,
    release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: Number.isFinite(parsedRate) ? Math.max(0, Math.min(parsedRate, 1)) : 0.05,
    sendDefaultPii: false,
    beforeSend: scrubEvent
  });
  enabled = true;
  return true;
}

export function captureException(error) {
  if (enabled) Sentry.captureException(error);
}

export function attachExpressErrorHandler(app) {
  if (enabled) Sentry.setupExpressErrorHandler(app);
}
