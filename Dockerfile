# OpenSMM gateway — one process: REST /v0 + MCP /mcp on :8080 (docs/DEPLOY.md)
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY spec ./spec
COPY llms.txt mcp.json README.md LICENSE ./

ENV NODE_ENV=production
# Persist gateway state on a mounted volume: -v opensmm-data:/data
ENV OPENSMM_STATE_FILE=/data/opensmm-state.json
VOLUME /data

EXPOSE 8080

ENTRYPOINT ["node", "--env-file-if-exists=.env"]
CMD ["src/adapters/inbound/gateway.ts"]
