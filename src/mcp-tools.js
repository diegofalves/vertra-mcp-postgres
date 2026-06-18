/**
 * MCP tool implementations for read-only PostgreSQL access.
 */

const ALLOWED_SCHEMAS = ["public", "rf_stg"];

const FORBIDDEN_COMMANDS = [
  "insert ",
  "update ",
  "delete ",
  "drop ",
  "alter ",
  "truncate ",
  "create ",
  "copy ",
  "grant ",
  "revoke ",
  "vacuum ",
  "analyze ",
  "set ",
  "reset "
];

/**
 * Returns true if the SQL is a read-only SELECT or WITH query
 * and contains no forbidden write/DDL commands.
 */
function isReadOnlySql(sql) {
  const normalized = sql.toLowerCase();
  const startsOk =
    normalized.startsWith("select") || normalized.startsWith("with");
  const hasForbidden = FORBIDDEN_COMMANDS.some((kw) =>
    normalized.includes(kw)
  );
  return startsOk && !hasForbidden;
}

/**
 * Throws if schemaName is not in the allowed list.
 */
function assertAllowedSchema(schemaName) {
  if (!ALLOWED_SCHEMAS.includes(schemaName)) {
    throw new Error(
      `Schema "${schemaName}" is not allowed. Allowed schemas: ${ALLOWED_SCHEMAS.join(", ")}`
    );
  }
}

/**
 * Returns true if the given table exists in information_schema.tables
 * for the given schema.
 */
async function tableExists(pool, schemaName, tableName) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'
     LIMIT 1`,
    [schemaName, tableName]
  );
  return result.rowCount > 0;
}

/**
 * Creates and returns all MCP tool definitions bound to the given pg pool.
 *
 * @param {import('pg').Pool} pool
 */
export function createMcpTools(pool) {
  return {
    get_database_health: {
      description:
        "Check database connectivity and return current user, database name, and server time.",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      },
      async execute(_args) {
        const result = await pool.query(
          "SELECT current_user, current_database(), now() AS server_time"
        );
        const row = result.rows[0];
        return {
          current_user: row.current_user,
          current_database: row.current_database,
          server_time: row.server_time
        };
      }
    },

    list_tables: {
      description:
        "List all base tables in the public and rf_stg schemas.",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      },
      async execute(_args) {
        const result = await pool.query(`
          SELECT table_schema, table_name
          FROM information_schema.tables
          WHERE table_schema IN ('public', 'rf_stg')
            AND table_type = 'BASE TABLE'
          ORDER BY table_schema, table_name
          LIMIT 200
        `);
        return result.rows;
      }
    },

    list_columns: {
      description:
        "List columns for a specific table, including data type and nullability.",
      inputSchema: {
        type: "object",
        properties: {
          schema_name: {
            type: "string",
            description: "Schema name (public or rf_stg)"
          },
          table_name: {
            type: "string",
            description: "Table name"
          }
        },
        required: ["schema_name", "table_name"]
      },
      async execute({ schema_name, table_name }) {
        assertAllowedSchema(schema_name);
        const result = await pool.query(
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schema_name, table_name]
        );
        return result.rows;
      }
    },

    run_readonly_query: {
      description:
        "Execute a read-only SELECT or WITH SQL query. Results are capped at 500 rows.",
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "A read-only SQL query (SELECT or WITH only)"
          }
        },
        required: ["sql"]
      },
      async execute({ sql }) {
        const trimmed = String(sql || "").trim();

        if (!trimmed) {
          throw new Error("SQL query must not be empty.");
        }

        if (trimmed.includes(";")) {
          throw new Error(
            "Multiple statements are not allowed. Remove the semicolon."
          );
        }

        if (!isReadOnlySql(trimmed)) {
          throw new Error(
            "Only read-only SELECT or WITH queries are allowed. Write and DDL commands are blocked."
          );
        }

        const result = await pool.query(trimmed);
        return {
          rowCount: result.rowCount,
          rows: result.rows.slice(0, 500)
        };
      }
    },

    count_table_rows: {
      description: "Return the total row count for a given table.",
      inputSchema: {
        type: "object",
        properties: {
          schema_name: {
            type: "string",
            description: "Schema name (public or rf_stg)"
          },
          table_name: {
            type: "string",
            description: "Table name"
          }
        },
        required: ["schema_name", "table_name"]
      },
      async execute({ schema_name, table_name }) {
        assertAllowedSchema(schema_name);

        const exists = await tableExists(pool, schema_name, table_name);
        if (!exists) {
          throw new Error(
            `Table "${schema_name}"."${table_name}" does not exist.`
          );
        }

        // Safe to interpolate identifiers because schema and table are validated above.
        const result = await pool.query(
          `SELECT COUNT(*) AS total FROM "${schema_name}"."${table_name}"`
        );
        return { total: result.rows[0].total };
      }
    }
  };
}
