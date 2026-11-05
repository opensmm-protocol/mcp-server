/** Dev entry: `npm run rest` — serves the OpenSMM /v0 REST API.
 *  Uses the rest-v1 provider when OPENSMM_REST_V1_* env vars are set, else MockProvider. */

import { createServer } from "node:http";
import { createStackFromEnv } from "../../../bootstrap.ts";
import { createRestHandler } from "./handler.ts";

const port = Number(process.env.PORT ?? 3100);
const { core, provider } = await createStackFromEnv();
const server = createServer((req, res) => {
  void createRestHandler(core)(req, res);
});

server.listen(port, () => {
  console.log(`OpenSMM v0.1-draft REST listening on http://localhost:${port}/v0 (provider: ${provider.providerId})`);
  console.log(`try: curl http://localhost:${port}/v0/capabilities`);
});
