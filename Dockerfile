# syntax=docker/dockerfile:1

# ---- build: whole workspace, then an isolated production bundle of the server ----
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable

# Dependency layer, cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config-schema/package.json packages/config-schema/
COPY packages/templates/package.json packages/templates/
COPY packages/cli/package.json packages/cli/
COPY packages/action/package.json packages/action/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter "@callog/server..." --filter @callog/web build \
 && pnpm --filter @callog/server deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/public

# Nothing below is loaded at runtime: type declarations, source maps, TS sources, docs.
# TypeScript itself is only an optional peer of cosmiconfig (via graphile-worker),
# needed solely for *.ts config files, which the server does not use.
RUN cd /out/node_modules/.pnpm \
 && find . -type f \( -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" -o -name "*.map" \
      -o \( -name "*.ts" ! -name "*.d.ts" \) -o -name "*.md" ! -iname "license*" \) -delete \
 && rm -rf typescript@* node_modules/typescript */node_modules/typescript

# ---- node runtime without npm, corepack, yarn and C headers (flattened below) ----
FROM node:24-alpine AS node
RUN rm -rf /usr/local/lib/node_modules /usr/local/include /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg

# ---- runtime ----
FROM scratch
COPY --from=node / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    LOG_FORMAT=json \
    PORT=3000 \
    WEB_DIST_DIR=/app/public
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
# ROLE=api|worker|all selects what this process runs.
CMD ["node", "dist/main.js"]
