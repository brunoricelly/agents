FROM oven/bun:1.4.2-alpine AS base

WORKDIR /app

# Refresh the Alpine snapshot carried by the Bun image, then keep both platform healthcheck clients
# and the privilege-drop helper in the final image.
RUN apk upgrade --no-cache \
  && apk add --no-cache curl su-exec

FROM base AS build

COPY package.json bun.lock ./
RUN HUSKY=0 bun install --frozen-lockfile

COPY . .

ARG BUN_PUBLIC_CDN_URL=""
ENV BUN_PUBLIC_CDN_URL=$BUN_PUBLIC_CDN_URL

# @edition-arg
ARG BUN_PUBLIC_EDITION="free"
ENV BUN_PUBLIC_EDITION=$BUN_PUBLIC_EDITION

# Generate the Prisma client without persisting a dummy connection string, then build the frontend.
RUN DATABASE_URL="postgres://postgres:postgres@localhost:5432/dummy" bun prisma generate
RUN bun run build

# NOTE: We intentionally do NOT use `bun build --compile` here. The standalone-compiled binary
# (and any `bun build` bundle) segfaults at boot on this app: bundling triggers a Bun heap-corruption
# bug, pinned to executing `@elysiajs/static`'s staticPlugin in the bundled build. The interpreted
# source (`bun src/index.ts`) is immune. Full investigation + repro: docs/bun-compile-segfault.md.
# Revisit `--compile` once the Bun bug is fixed or staticPlugin is replaced.

FROM base AS runtime-dependencies

COPY package.json bun.lock ./
# Peer auto-installation pulls the legacy `langchain` compatibility package even though the runtime
# integration imports `@langchain/core` directly. Omitting peers also keeps that unused vulnerable
# tree, TypeScript, esbuild, and other build-only packages out of the final image.
RUN bun install --frozen-lockfile --production --omit peer --ignore-scripts

FROM base AS runtime

ENV NODE_ENV=production \
  HOME=/home/bun

ARG BUN_PUBLIC_CDN_URL=""
ENV BUN_PUBLIC_CDN_URL=$BUN_PUBLIC_CDN_URL

# @edition-arg
ARG BUN_PUBLIC_EDITION="free"
ENV BUN_PUBLIC_EDITION=$BUN_PUBLIC_EDITION

COPY --from=runtime-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=bun:bun /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=bun:bun /app/prisma ./prisma
COPY --from=build --chown=bun:bun /app/generated ./generated
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/scripts/db-bootstrap.ts ./scripts/db-bootstrap.ts
COPY --from=build /app/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# stdio MCP launchers (gated by MCP_STDIO_ENABLED). `bunx` is native to the Bun base image; `uvx`
# runs Python MCP servers. Install CPython under the runtime user's HOME because the MCP transport
# forwards HOME/PATH but intentionally does not forward arbitrary UV_* variables. NOTE: musl Python
# builds are x86_64-only today (aarch64-musl cannot yet install Python via uv). Pin uv by digest.
COPY --from=ghcr.io/astral-sh/uv:0.11.26@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5 /uv /uvx /usr/local/bin/
RUN HOME=/home/bun uv python install 3.12 \
  && mkdir -p /app/logs /app/storage /app/data \
  && chown -R bun:bun /home/bun /app/logs /app/storage /app/data \
  && chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

# Container healthcheck on /api/health using wget (always present in the bun:alpine image). With a
# HEALTHCHECK declared, the platform uses the container's own probe instead of injecting one.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

# The entrypoint repairs ownership on existing named volumes, then drops to bun before migrations or
# application code run. This preserves upgrades from older images that wrote the volume as root.
ENTRYPOINT ["docker-entrypoint.sh"]

# Default boot: provision the runtime role (idempotent), migrate as the owner, then run the server
# interpreted (see the --compile NOTE above). Requires MIGRATION_DATABASE_URL (superuser) +
# DATABASE_URL (runtime role). Orchestrators may override this command for one-shot migration jobs.
CMD ["sh", "-c", "bun scripts/db-bootstrap.ts && bun prisma migrate deploy && exec bun src/index.ts"]
