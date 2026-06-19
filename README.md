# vertra-mcp-postgres

Read-only MCP server that exposes a Railway PostgreSQL database to Claude agents via the Model Context Protocol (MCP) over SSE transport.

## How it works

The server runs as an Express HTTP service with two layers:

- **MCP/SSE layer** — `GET /sse` opens a persistent SSE connection; `POST /message` receives client-to-server messages. Each connection gets its own MCP `Server` instance.
- **HTTP/DB layer** — REST endpoints (`/health`, `/db/health`, `/db/tables`, `/db/query`) for direct inspection and health checks.

All paths that touch the database enforce read-only access: only `SELECT` and `WITH` queries are accepted; write and DDL keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `COPY`, `GRANT`, `REVOKE`, `VACUUM`, `ANALYZE`, `SET`, `RESET`) are blocked at the application level.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL_READONLY` | Yes | PostgreSQL connection string for the read-only Railway database |
| `PORT` | No | HTTP port (default: `3000`) |

## Running locally

```bash
npm install
DATABASE_URL_READONLY=postgres://... npm start
```

## MCP tools

These are the tools advertised to Claude agents when they connect via SSE.

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

### SSE endpoint

Point the MCP toolset at the deployed service's `/sse` endpoint:

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
| `GET` | `/db/health` | DB connectivity check |
| `GET` | `/db/tables` | Lists tables in `public` schema |
| `POST` | `/db/query` | Runs a read-only SQL query; body: `{"sql": "..."}` |
| `GET` | `/sse` | Opens MCP SSE connection |
| `POST` | `/message?sessionId=<id>` | MCP client-to-server message channel |
