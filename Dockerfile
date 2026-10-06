# --- deps ---------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build --------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- web (standalone runtime) -------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TM_DATA_DIR=/app/.data
# tar: extracting GitHub commit tarballs. curl: HEALTHCHECK.
# No bash: this image is the web tier, which never executes untrusted repo code
# (the local runner is refused under NODE_ENV=production). Builds belong to the
# `worker` stage below or a dedicated builder, which use the docker runner.
RUN apk add --no-cache tar curl \
  && addgroup -S tm && adduser -S tm -G tm \
  && mkdir -p /app/.data && chown -R tm:tm /app/.data
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/src/server/builder/static-server.cjs ./src/server/builder/static-server.cjs
USER tm
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:3000/api/healthz || exit 1
CMD ["node", "server.js"]

# --- worker (full build stage + tsx) ------------------------------------
FROM build AS worker
ENV NODE_ENV=production TM_DATA_DIR=/app/.data
RUN mkdir -p /app/.data
CMD ["npx", "tsx", "worker/index.ts"]
