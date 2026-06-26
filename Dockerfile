# Build stage. Do NOT set NODE_ENV=production here — `npm ci` would then omit the
# devDependencies (typescript, @types/*) that `next build` needs. Production env
# is set only in the runner stage below.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
# ponytail: Next.js standalone reads process.env.HOSTNAME and binds to it.
# Docker/Railway set HOSTNAME to the container ID, so without this the server
# binds to the container-id interface and Railway's healthcheck can't reach it.
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 8080
# Drop root — standalone output is world-readable and the server binds :8080 (>1024).
USER node
CMD ["node", "server.js"]
