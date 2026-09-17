FROM oven/bun:1.3.14 AS builder
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/lore-core/package.json ./packages/lore-core/package.json
COPY packages/typescript-sdk/package.json ./packages/typescript-sdk/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY tools/sdk-codegen/package.json ./tools/sdk-codegen/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.14 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Health probes use curl; code indexing reads operator-mounted Git repositories.
RUN apt-get update && apt-get install -y --no-install-recommends curl git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.worker ./.worker
COPY --from=builder /app/public ./public
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts/database ./scripts/database
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000
USER bun
CMD ["bun", "--no-env-file", "server.js"]
