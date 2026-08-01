import assert from "node:assert/strict";
import test from "node:test";

import { scrubEvent } from "../src/observability.js";

test("scrubs request secrets, user data and query breadcrumbs", () => {
  const event = scrubEvent({
    request: {
      url: "https://example.test/db/query",
      data: { sql: "SELECT * FROM users" },
      headers: { authorization: "Bearer secret" },
      cookies: "session=secret",
      query_string: "token=secret"
    },
    user: { email: "person@example.test" },
    breadcrumbs: [{ category: "query", message: "SELECT * FROM users", data: { sql: "secret" } }]
  });

  assert.deepEqual(event.request, { url: "https://example.test/db/query" });
  assert.equal(event.user, undefined);
  assert.deepEqual(event.breadcrumbs, [
    { category: "query", message: "dependency operation", data: undefined }
  ]);
});
