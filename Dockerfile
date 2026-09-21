FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY vertra-mcp-postgres/package.json vertra-mcp-postgres/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app
RUN groupadd --system --gid 1001 vertra \
    && useradd --system --uid 1001 --gid vertra vertra
COPY --from=dependencies --chown=vertra:vertra /app/node_modules ./node_modules
COPY --chown=vertra:vertra vertra-mcp-postgres/package.json ./package.json
COPY --chown=vertra:vertra vertra-mcp-postgres/src ./src

USER vertra
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
