# vertra-mcp-postgres

Read-only MCP server that exposes a Railway PostgreSQL database to Claude agents via the Model Context Protocol (MCP) over Streamable HTTP, with legacy SSE fallback.

## How it works

The server runs as an Express HTTP service with two layers:

- **MCP/Streamable HTTP layer** — `POST/GET/DELETE /mcp` serves the preferred stateful Streamable HTTP transport. Each session gets its own MCP `Server` instance.
- **MCP/SSE layer** — `GET /sse` opens a persistent legacy SSE connection; `POST /message` receives client-to-server messages.
- **HTTP/DB layer** — REST endpoints (`/health`, `/db/health`, `/db/tables`, `/db/query`) for direct inspection and health checks.

`/health` and `/ready` are public probes. Every MCP or database route requires
`Authorization: Bearer <MCP_API_KEY>`. Read-only queries run inside a bounded
`READ ONLY` transaction and return at most 500 rows.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL_READONLY` | Yes | PostgreSQL connection string for the read-only Railway database |
| `MCP_API_KEY` | Yes | Bearer token required by all MCP and `/db/*` routes |
| `MCP_ALLOWED_ORIGINS` | No | Comma-separated browser origins; empty denies browser CORS while allowing non-browser clients |
| `MCP_ENABLE_REST_QUERY` | No | Enables `POST /db/query`; disabled by default |
| `MCP_DB_POOL_MAX` | No | Maximum PostgreSQL pool size (default `4`, maximum `20`) |
| `MCP_DB_CONNECT_TIMEOUT_MS` | No | Connection timeout (default `5000`) |
| `MCP_DB_STATEMENT_TIMEOUT_MS` | No | Query timeout (default `5000`, maximum `60000`) |
| `MCP_DB_LOCK_TIMEOUT_MS` | No | PostgreSQL lock timeout (default `1000`) |
| `MCP_DB_IDLE_TRANSACTION_TIMEOUT_MS` | No | Idle transaction timeout (default `5000`) |
| `SENTRY_DSN` | No | Enables Sentry error tracking when configured |
| `SENTRY_ENVIRONMENT` | No | Sentry environment; defaults to Railway environment |
| `SENTRY_RELEASE` | No | Release identifier; defaults to Railway commit SHA |
| `SENTRY_TRACES_SAMPLE_RATE` | No | Trace sample rate (default `0.05`) |
| `PORT` | No | HTTP port (default: `3000`) |

## Running locally

```bash
npm install
DATABASE_URL_READONLY=postgres://... MCP_API_KEY=... npm start
```

## MCP tools

These are the tools advertised to Claude agents when they connect via Streamable HTTP or legacy SSE.

### `get_database_health`

Returns the current PostgreSQL user, database name, and server timestamp. No parameters.

### `list_tables`

Lists all base tables in the `public` and `rf_stg` schemas, ordered by schema and table name. No parameters.

### `list_columns`

Lists columns for a specific table including data type and nullability.

| Parameter | Type | Description |
|---|---|---|
| `schema_name` | string | `public` or `rf_stg` |
| `table_name` | string | Table name |

### `run_readonly_query`

Executes a read-only `SELECT` or `WITH` SQL query. Results are capped at 500 rows. Multiple statements (semicolons) are rejected.

| Parameter | Type | Description |
|---|---|---|
| `sql` | string | A read-only SQL query |

### `count_table_rows`

Returns the total row count for a given table. Validates that the table exists before querying.

| Parameter | Type | Description |
|---|---|---|
| `schema_name` | string | `public` or `rf_stg` |
| `table_name` | string | Table name |

## Connecting a Claude agent (Agent SDK)

### Streamable HTTP endpoint

Point the MCP toolset at the deployed service's `/mcp` endpoint. The client must send the API key as an `Authorization: Bearer` header. Store the key in the client's secret store; never put it in the URL, repository or logs.

The legacy `/sse` endpoint remains available as a fallback for clients that do not support Streamable HTTP.

### Agent SDK example

The MCP toolset URL in the example below may be `/mcp` (preferred) or `/sse` (legacy fallback):

```python
import anthropic

client = anthropic.Anthropic()

agent = client.beta.agents.create(
    name="vertra-db-agent",
    model="claude-sonnet-4-6",
    tools=[
        {"type": "agent_toolset_20260401", "default_config": {"enabled": True}},
        {
            "type": "mcp_toolset",
            "mcp_server_name": "railway_postgres_readonly",
            "mcp_server_url": "https://<your-railway-url>/sse",
            "default_config": {
                "enabled": True,
                "permission_policy": {"type": "always_allow"}
            }
        }
    ]
)
```

### Why `always_allow`

The default `always_ask` permission policy causes every MCP tool call to pause and wait for manual confirmation — this blocks automated database audits and makes the agent unusable in production workflows.

`always_allow` is safe here because the server enforces read-only access at multiple levels:

1. `isReadOnlySql()` in `src/mcp-tools.js` rejects any query that doesn't start with `SELECT` or `WITH` and blocks all write/DDL keywords.
2. `assertAllowedSchema()` restricts access to the `public` and `rf_stg` schemas only.
3. Result sets are hard-capped at 500 rows.
4. The Railway database user itself should be a read-only role with no write privileges (defence in depth).

### Updating an existing agent

If you already created the agent with `always_ask` and need to switch:

```python
client.beta.agents.update(
    "<agent-id>",
    tools=[
        {"type": "agent_toolset_20260401", "default_config": {"enabled": True}},
        {
            "type": "mcp_toolset",
            "mcp_server_name": "railway_postgres_readonly",
            "mcp_server_url": "https://<your-railway-url>/sse",
            "default_config": {
                "enabled": True,
                "permission_policy": {"type": "always_allow"}
            }
        }
    ]
)
```

### Manually approving a blocked tool call (one-off)

If a session is already idle waiting for approval, unblock it without restarting:

```python
client.beta.sessions.events.send(
    session_id="<session-id>",
    events=[{
        "type": "tool_confirmation",
        "tool_use_id": "<tool-use-id>",
        "result": "allow"
    }]
)
```

This unblocks only that one call. The next call will block again unless you update the agent config as shown above.

## REST endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service liveness check (no DB call) |
| `GET` | `/ready` | Readiness check with a `SELECT 1` against PostgreSQL |
| `GET` | `/db/health` | Authenticated DB connectivity check |
| `GET` | `/db/tables` | Authenticated table list for allowed schemas |
| `POST` | `/db/query` | Authenticated optional REST query; disabled by default |
| `POST/GET/DELETE` | `/mcp` | Authenticated MCP Streamable HTTP session |
| `GET` | `/sse` | Opens an authenticated legacy MCP SSE connection |
| `POST` | `/message?sessionId=<id>` | Authenticated legacy MCP client-to-server channel |

## Validation

```bash
npm ci
npm test
```

Production acceptance requires public `/health` and `/ready` to return 2xx,
all protected routes to return 401 without a Bearer token, and an authorized
MCP client to complete a read-only `SELECT 1`.
