#!/usr/bin/env bash
# Container smoke test for the published OpenSMM gateway image (ZHC-301).
#
# Starts the image with no env keys, then checks a running node end to end:
#   /v0/services 200 (mock catalog, explicitly marked) → MCP initialize →
#   tools/list → the same clientReference returns the same orderId →
#   /v0/providers agrees with the catalog's providerRefs.
#
# Usage:
#   scripts/smoke-container.sh                       # ghcr.io/opensmm-protocol/gateway:latest
#   SMOKE_IMAGE=opensmm-gateway:ci scripts/smoke-container.sh    # a local build
#   SMOKE_PORT=18080 scripts/smoke-container.sh        # fixed host port
#
# Env:
#   SMOKE_IMAGE         image reference (default: ghcr.io/opensmm-protocol/gateway:latest)
#   SMOKE_PORT          host port (default: ephemeral, picked by Docker)
#   SMOKE_WAIT_SECONDS  readiness budget (default: 10, the DoD limit)
#
# Exit code: 0 on success, non-zero on the first failed check.

set -euo pipefail

IMAGE="${SMOKE_IMAGE:-ghcr.io/opensmm-protocol/gateway:latest}"
WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-10}"
CONTAINER="opensmm-smoke-$$"
BASE_URL=""

info() { printf 'smoke: %s\n' "$*"; }
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    printf '\n--- container logs (%s) ---\n' "$CONTAINER" >&2
    docker logs --tail 100 "$CONTAINER" 2>&1 || true
    printf -- '--- end of container logs ---\n\n' >&2
  fi
  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  echo "smoke: FAIL: docker is not installed" >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "smoke: FAIL: python3 is not installed" >&2
  exit 1
}

info "image ${IMAGE}"
if [ -n "${SMOKE_PORT:-}" ]; then
  PUBLISH="127.0.0.1:${SMOKE_PORT}:8080"
else
  PUBLISH="127.0.0.1::8080"
fi

# No keys, no external services: the node must boot on the mock catalog alone.
if ! docker run --detach --name "$CONTAINER" --publish "$PUBLISH" "$IMAGE" >/dev/null; then
  echo "smoke: FAIL: could not start ${IMAGE}" >&2
  echo "smoke: if this is a ghcr image, the package may be private — anonymous pull" >&2
  echo "smoke: must work (package visibility: public)." >&2
  exit 1
fi

MAPPING="$(docker port "$CONTAINER" 8080/tcp | head -n 1)"
HOST_PORT="${MAPPING##*:}"
[ -n "$HOST_PORT" ] || {
  echo "smoke: FAIL: Docker published no host port for 8080/tcp" >&2
  exit 1
}
BASE_URL="http://127.0.0.1:${HOST_PORT}"
info "container ${CONTAINER} on ${BASE_URL}"

started_at=$SECONDS
ready=0
while [ $((SECONDS - started_at)) -lt "$WAIT_SECONDS" ]; do
  if curl --silent --fail --max-time 2 --output /dev/null "${BASE_URL}/v0/services"; then
    ready=1
    break
  fi
  sleep 0.2
done
[ "$ready" -eq 1 ] || {
  echo "smoke: FAIL: /v0/services did not answer 200 within ${WAIT_SECONDS}s" >&2
  exit 1
}
info "/v0/services 200 after $((SECONDS - started_at))s (budget ${WAIT_SECONDS}s)"

# All HTTP checks below run in one process so a failure prints one clear reason.
python3 - "$BASE_URL" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base = sys.argv[1]
failures = []


def check(condition, message):
    if condition:
        print(f"smoke: PASS: {message}")
    else:
        failures.append(message)
        print(f"smoke: FAIL: {message}", file=sys.stderr)


def request(method, path, payload=None, accept="application/json"):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={"content-type": "application/json", "accept": accept},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def get_json(path):
    status, body = request("GET", path)
    check(status == 200, f"GET {path} → {status} (expected 200)")
    if status != 200:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        failures.append(f"GET {path} body is not JSON")
        return None


def rpc(payload):
    status, body = request("POST", "/mcp", payload, accept="application/json, text/event-stream")
    check(status == 200, f"POST /mcp {payload['method']} → {status} (expected 200)")
    if status != 200:
        return None
    text = body.decode()
    # Stateless Streamable HTTP answers either an SSE data line or plain JSON.
    for line in text.splitlines():
        if line.startswith("data: "):
            text = line[len("data: "):]
            break
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        failures.append(f"POST /mcp {payload['method']} body is not JSON: {text[:200]}")
        return None


def rpc_request(rpc_id, method, params=None):
    return {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}}


def tool(name, arguments):
    answer = rpc(rpc_request(9, "tools/call", {"name": name, "arguments": arguments}))
    if not answer:
        return None
    if "result" not in answer:
        failures.append(f"tools/call {name} returned an error: {json.dumps(answer)[:300]}")
        return None
    return answer["result"].get("structuredContent")


# 1. Catalog: served, non-empty, and honest about being mock supply.
catalog = get_json("/v0/services")
services = (catalog or {}).get("services") or []
check(bool(services), f"catalog serves {len(services)} services")
check(
    all(service.get("synthetic") is True for service in services),
    "every catalog service is marked synthetic (mock, not real supply)",
)
provider_refs = {service.get("providerRef") for service in services if service.get("providerRef")}

# 2. MCP initialize.
initialized = rpc(
    rpc_request(
        1,
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "container-smoke", "version": "0"},
        },
    )
)
check(
    bool(initialized) and initialized.get("result", {}).get("serverInfo", {}).get("name") == "opensmm",
    "MCP initialize answers serverInfo.name=opensmm",
)

# 3. tools/list.
listed = rpc(rpc_request(2, "tools/list"))
tools = ((listed or {}).get("result") or {}).get("tools") or []
tool_names = [item.get("name") for item in tools]
check(len(tools) >= 10, f"tools/list returns {len(tools)} tools")
check("create_order" in tool_names, "tools/list includes create_order")

# 4. Idempotency: one clientReference → one orderId, across two calls.
order_id = None
if services:
    service = services[0]
    quote_status, quote_body = request(
        "POST",
        "/v0/quotes",
        {"serviceId": service["serviceId"], "quantity": 100, "link": "https://t.me/opensmm_smoke"},
    )
    check(quote_status in (200, 201), f"POST /v0/quotes → {quote_status} (expected 200/201)")
    if quote_status in (200, 201):
        order = {
            "quoteId": json.loads(quote_body)["quoteId"],
            "link": "https://t.me/opensmm_smoke",
            "clientReference": "container-smoke-idempotency",
        }
        first = tool("create_order", order)
        second = tool("create_order", order)
        order_id = (first or {}).get("orderId")
        check(bool(order_id), f"create_order returns an orderId ({order_id})")
        check(
            first == second,
            "a repeated clientReference returns the same orderId",
        )

# 5. Provider list agrees with the catalog.
providers_body = get_json("/v0/providers")
providers = (providers_body or {}).get("providers") or []
provider_keys = {provider.get("providerKey") for provider in providers}
check(bool(providers), f"/v0/providers lists {len(providers)} provider(s)")
check(bool(provider_refs), f"catalog carries {len(provider_refs)} providerRef(s)")
check(
    provider_refs.issubset(provider_keys),
    "/v0/providers covers every providerRef in the catalog",
)

if failures:
    print(f"smoke: {len(failures)} check(s) failed", file=sys.stderr)
    sys.exit(1)
print("smoke: all container checks passed")
PY

info "container smoke test passed for ${IMAGE}"
