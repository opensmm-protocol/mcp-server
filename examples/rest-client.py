#!/usr/bin/env python3
"""OpenSMM REST client example in plain Python: read the capabilities and the
catalog, price a service, place an order on the node's mock provider, then
repeat the same order to show idempotency (`clientReference` -> one `orderId`).

Usage:
  python3 examples/rest-client.py [base-url] [options]

Options:
  --client-reference <ref>  idempotency key of the order
  --quote <quote-id>        reuse a quote issued earlier (e.g. by the MCP example)

Default base URL is http://127.0.0.1:8080 - a node from `npm run gateway`.
Standard library only (urllib.request + json): no pip install, no API keys, no
money. The order stays REQUIRES_PAYMENT and nothing is executed.
"""

import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://127.0.0.1:8080"
QUANTITY = 100
# Target of the order. The mock provider stores it and never touches it.
LINK = "https://t.me/opensmm_example"
TIMEOUT_SECONDS = 15


def usage():
    return """Usage: python3 examples/rest-client.py [base-url] [options]

Options:
  --client-reference <ref>  idempotency key of the order (default: python-demo-<timestamp>)
  --quote <quote-id>        reuse a quote issued earlier instead of pricing a new one
  -h, --help                show this help

Example:
  npm run gateway                                   # in another terminal
  python3 examples/rest-client.py http://127.0.0.1:8080 --client-reference my-first-order
"""


def parse_args(argv):
    options = {"base_url": DEFAULT_BASE_URL, "quote": None, "client_reference": None, "help": False}
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("-h", "--help"):
            options["help"] = True
        elif arg in ("--client-reference", "--quote"):
            if index + 1 >= len(argv) or not argv[index + 1]:
                raise RuntimeError("%s requires a value" % arg)
            if arg == "--client-reference":
                options["client_reference"] = argv[index + 1]
            else:
                options["quote"] = argv[index + 1]
            index += 1
        elif arg.startswith("-"):
            raise RuntimeError("unknown option: %s" % arg)
        else:
            options["base_url"] = arg.rstrip("/")
        index += 1
    return options


def _decode(raw):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        return None


def request(base_url, route, body=None):
    """One HTTP call; the status is returned instead of raised so 402 is readable."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base_url + route,
        data=data,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="GET" if body is None else "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            return response.status, _decode(response.read())
    except urllib.error.HTTPError as err:
        return err.code, _decode(err.read())


def check(response, accept=(200,)):
    """Turn an OpenSMM error body into a readable raise."""
    status, body = response
    if status in accept:
        return body
    error = body.get("error") if isinstance(body, dict) else None
    if error:
        raise RuntimeError("%s: %s" % (error.get("code"), error.get("message")))
    raise RuntimeError("%s from the node: %s" % (status, json.dumps(body)))


def run(argv):
    try:
        options = parse_args(argv)
        if options["help"]:
            print(usage())
            return 0

        base_url = options["base_url"]
        client_reference = options["client_reference"] or "python-demo-%d" % int(time.time() * 1000)
        print("node:    %s" % base_url)

        # 0. What the node speaks. A defaults node offers the mock payment rail.
        capabilities = check(request(base_url, "/v0/capabilities"))
        print(
            "protocol: %s - %d commands, payment: %s"
            % (
                capabilities.get("protocolVersion"),
                len(capabilities.get("commands") or []),
                ", ".join(capabilities.get("paymentMethods") or []),
            )
        )

        # 1. The catalog. A node on defaults serves the mock catalog.
        catalog = check(request(base_url, "/v0/services"))
        services = catalog.get("services") or []
        if not services:
            raise RuntimeError("the node returned an empty catalog: no services to order")
        service = services[0]

        if service.get("synthetic") is not True:
            raise RuntimeError(
                "refusing to place a demo order: %s is not marked synthetic. "
                "This example orders only on the mock catalog - see examples/README.md."
                % service.get("serviceId")
            )
        print("catalog: MOCK - every service is marked synthetic: not real supply, no real money")
        print("service: %s - %s" % (service.get("serviceId"), service.get("name")))

        # 2. A quote. Pricing is mandatory before an order, and a quote is consumed once.
        quote_id = options["quote"]
        if quote_id:
            print("quote:   %s (reused)" % quote_id)
        else:
            quote = check(
                request(
                    base_url,
                    "/v0/quotes",
                    {"serviceId": service.get("serviceId"), "quantity": QUANTITY, "link": LINK},
                ),
                accept=(201,),
            )
            quote_id = quote.get("quoteId")
            print(
                "quote:   %s - %s %s for %s (mock rate)"
                % (
                    quote_id,
                    quote["amount"]["value"],
                    quote["amount"]["currency"],
                    quote["quantity"],
                )
            )

        # 3. The order. An unpaid order answers 402 and still carries the order body.
        order_body = {"quoteId": quote_id, "link": LINK, "clientReference": client_reference}
        order = check(request(base_url, "/v0/orders", order_body), accept=(200, 402))
        print(
            'order:   %s - %s, clientReference "%s"'
            % (order.get("orderId"), order.get("paymentStatus"), order.get("clientReference"))
        )

        # 4. The same call again: same clientReference -> same order, nothing new created.
        replay = check(request(base_url, "/v0/orders", order_body), accept=(200, 402))
        if replay.get("orderId") != order.get("orderId"):
            raise RuntimeError(
                "the node returned a second orderId (%s) for one clientReference"
                % replay.get("orderId")
            )
        print("replay:  %s - same orderId, no second order created" % replay.get("orderId"))
        print("done:    Python client OK")
        return 0
    except RuntimeError as err:
        print("error: %s" % err, file=sys.stderr)
        if str(err).startswith("IDEMPOTENCY_CONFLICT"):
            print(
                "hint: that clientReference already belongs to an order made from another quote; "
                "pass the --quote it was made with, or a new --client-reference",
                file=sys.stderr,
            )
        return 1
    except (urllib.error.URLError, TimeoutError) as err:
        print("error: %s" % getattr(err, "reason", err), file=sys.stderr)
        print(
            "hint: start a node first - npm run gateway "
            "(or bin/opensmm.mjs gateway --port 8080)",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
