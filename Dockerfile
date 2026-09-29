# @praesidia/sdk — build + test image.
# Purpose: CI / reproducible builds and a load smoke check. This is NOT a
# deployable service — the package is a library published to npm. The image
# exists so the build + test pipeline is reproducible on any host.
#
# Base: node:26-alpine (Current), npm 11 (bundled). Runs as a non-root user.

FROM node:26.10.0-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS build
# node:26.10.0-alpine3.24
WORKDIR /app
# Install with a committed lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Compile (tsc) and run the full vitest suite as part of the build.
COPY tsconfig.json tsconfig.spec.json vitest.config.ts ./
COPY src ./src
# The Vitest suite also includes the API-contract scanner regression tests in
# scripts/. Copy that directory before the coverage run; otherwise an image build
# silently runs fewer tests than the host/CI suite while claiming to run all of
# them.
COPY scripts ./scripts
COPY README.md LICENSE ./
RUN npm run build && npm run test:coverage && npm run typecheck:spec

# ---- runtime: minimal, non-root, carries only the built output ----
FROM node:26.10.0-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runtime
# node:26.10.0-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S praesidia && adduser -S praesidia -G praesidia
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
USER praesidia
# Smoke: load the built ESM entrypoint and report the export count.
CMD ["node", "-e", "import('./dist/index.js').then(m => console.log('@praesidia/sdk OK —', Object.keys(m).length, 'exports'))"]
