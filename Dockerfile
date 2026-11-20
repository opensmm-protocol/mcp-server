# OpenSMM gateway — one process: REST /v0 + MCP /mcp on :8080 (docs/DEPLOY.md).
# Published as ghcr.io/opensmm-protocol/gateway by .github/workflows/publish.yml.
# node_modules of the published package reject TypeScript type stripping, so the
# image ships the compiled `dist/` and the plain-JS entry point from `bin/`.

FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production deps are installed here: the distroless runtime has no shell or npm.
FROM build AS deps
RUN npm ci --omit=dev && npm cache clean --force

# /data is created here (no RUN in the runtime stage); copied with nonroot ownership.
RUN mkdir -p /data

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=deps --chown=65532:65532 /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY spec ./spec
COPY llms.txt mcp.json README.md LICENSE ./

# /data is the only writable path: the state snapshot. The node runs as
# nonroot (65532); a named volume inherits this ownership from the directory.
COPY --from=deps --chown=65532:65532 /data /data
USER nonroot

# Persist gateway state on a mounted volume: -v opensmm-data:/data
ENV OPENSMM_STATE_FILE=/data/opensmm-state.json
VOLUME /data

EXPOSE 8080

# One node, no keys: `docker run -p 127.0.0.1:8080:8080 <image>` serves the mock catalog.
# PORT/payment/provider env override the defaults; CLI flags go after the entry:
# `docker run <image> bin/opensmm.mjs gateway --port 9000`.
# ENTRYPOINT is the distroless one: /nodejs/bin/node.
CMD ["bin/opensmm.mjs", "gateway"]
