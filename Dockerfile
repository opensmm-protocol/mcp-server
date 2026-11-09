# OpenSMM gateway — one process: REST /v0 + MCP /mcp on :8080 (docs/DEPLOY.md).
# Published as ghcr.io/opensmm-protocol/gateway by .github/workflows/publish.yml.
# node_modules of the published package reject TypeScript type stripping, so the
# image ships the compiled `dist/` and the plain-JS entry point from `bin/`.

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY spec ./spec
COPY llms.txt mcp.json README.md LICENSE ./

# Persist gateway state on a mounted volume: -v opensmm-data:/data
ENV OPENSMM_STATE_FILE=/data/opensmm-state.json
VOLUME /data

EXPOSE 8080

# One node, no keys: `docker run -p 8080:8080 <image>` serves the mock catalog.
# PORT/payment/provider env override the defaults; CLI flags go after the entry:
# `docker run <image> bin/opensmm.mjs gateway --port 9000`.
ENTRYPOINT ["node"]
CMD ["bin/opensmm.mjs", "gateway"]
