/**
 * Release version of this node, printed in the entry-point banners, returned by
 * `/health` and reported as MCP `serverInfo.version`.
 *
 * The single source of truth is `version` in `package.json`: bump it there,
 * then `npm run manifests:sync` and this constant. `test/release-version.test.ts`
 * fails when this value drifts from `package.json` or `server.json`.
 */
export const VERSION = "0.1.8";
