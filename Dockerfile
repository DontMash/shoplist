# ---- install and TypeScript/application build stage -------------------------
FROM node:24-alpine AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web ./apps/web
COPY apps/server ./apps/server
RUN pnpm --filter @shoplist/server build
RUN pnpm --filter @shoplist/web build

# Keep only the backend and its production dependencies for the runtime image.
RUN pnpm --filter @shoplist/server deploy --prod --legacy /app/deploy

# ---- runtime stage ----------------------------------------------------------
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    PUBLIC_DIR=/app/public-dist

WORKDIR /app

# data dir must be writable by the unprivileged runtime user
RUN mkdir -p /app/data && chown -R node:node /app/data

COPY --from=build /app/deploy ./
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./public-dist
# Keep the immutable PWA source assets available for PUBLIC_DIR overrides.
COPY --from=build /app/apps/web/public ./public

USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
