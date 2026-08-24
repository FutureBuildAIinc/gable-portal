# SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
# SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# package.json + lockfile first, so a source-only change reuses the install
# layer. `npm ci` and not `npm install`: the lockfile is the input, and a build
# that can silently resolve a different tree is not a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Two artifacts, both needed at runtime:
#   dist/         the client bundle (vite)
#   dist-server/  the Node host (esbuild, --packages=external)
#
# NOTHING is baked in here. Deliberately no ARG/ENV for GABLE_API_URL, no
# VITE_-prefixed anything: the ERP's address is read at RUN time by
# server/serve.ts and never reaches the client bundle. A build artifact that
# hard-codes which ERP it talks to cannot be promoted from staging to
# production, and a build artifact that hard-codes a SECRET cannot be published
# at all. See .do/app-portal.yaml.
RUN npm run build && npm run build:server

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache curl

# `esbuild --packages=external` leaves npm imports unbundled — but this server
# imports only Node builtins and its own relative modules (the two `vite`
# imports under server/ are type-only and are erased). So there is no
# node_modules in the runtime image at all, which is the smallest and least
# attackable surface this can have. If a future server module takes a real
# runtime dependency, add a `npm ci --omit=dev` layer here; the build will fail
# loudly with a module-not-found rather than degrade.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

# The dealer admin console persists its config and (write-only) API key under
# .gablenow/. In a container that is EPHEMERAL: it is recreated on every
# deploy, so branding configured through the console does not survive a
# restart. Mount a volume here, or configure branding at the source, if that
# matters for your deployment.
RUN mkdir -p /app/.gablenow && chown -R node:node /app/.gablenow

# The image runs unprivileged. `node:alpine` ships this user; creating another
# one buys nothing and, on DigitalOcean's kaniko builder, custom users have a
# history of failing readiness with no surfaced logs (see gable/app/Dockerfile
# for the same lesson learned the expensive way).
USER node

# App Platform, Docker, Kubernetes and Fly all reach the process from OUTSIDE
# the container's network namespace. server/serve.ts therefore defaults HOST to
# 0.0.0.0 — a loopback bind here starts cleanly, logs cheerfully, passes a
# local smoke test, and receives no traffic whatsoever.
ENV PORT=8080
EXPOSE 8080

# /healthz is static and does NOT touch the ERP. A gable outage must not take
# the portal out of rotation as well: the contractor should keep the board and
# an honest "Supplier unreachable" badge, not a 503 from the router.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "dist-server/serve.mjs"]
