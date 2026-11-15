import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  diagnoseProvider,
  formatDoctorReport,
  redactKey,
  runDoctorCli,
} from "../src/cli/provider-doctor.ts";

describe("provider-doctor: Level-0 panel pre-onboarding checks", () => {
  it("diagnoses a standard reachable panel", async () => {
    const fetchCalls: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      fetchCalls.push({ url: String(url), body });
      const action = body.get("action");

      if (action === "balance") {
        return new Response(JSON.stringify({ balance: "142.50", currency: "USD" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (action === "services") {
        return new Response(
          JSON.stringify([
            {
              service: 101,
              name: "Telegram Channel Members",
              category: "Telegram",
              description: "High quality real channel members",
              rate: "0.25",
              min: 100,
              max: 50000,
              refill: true,
              cancel: false,
            },
            {
              service: 102,
              name: "Instagram Likes",
              category: "Instagram",
              description: "Instant start",
              rate: "0.10",
              min: 50,
              max: 10000,
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
    }) as typeof fetch;

    const res = await diagnoseProvider({
      url: "https://panel.example/api/v2",
      key: "secret-test-key",
      fetchImpl,
    });

    assert.equal(res.ok, true);
    assert.equal(res.baseUrl, "https://panel.example/api/v2");

    // (1) HTTPS reachability + JSON vs HTML/Cloudflare
    assert.equal(res.checks.reachability.ok, true);
    assert.equal(res.checks.reachability.https, true);
    assert.equal(res.checks.reachability.isJson, true);
    assert.equal(res.checks.reachability.isHtmlOrCloudflare, false);

    // (2) action=balance works, report balance/currency
    assert.equal(res.checks.balance.ok, true);
    assert.equal(res.checks.balance.balance, "142.50");
    assert.equal(res.checks.balance.currency, "USD");

    // (3) action=services returns non-empty array, report catalog size
    assert.equal(res.checks.services.ok, true);
    assert.equal(res.checks.services.catalogSize, 2);

    // (4) detect envelope (plain array vs wrapped) and field aliases
    assert.equal(res.checks.envelopeAndAliases.ok, true);
    assert.equal(res.checks.envelopeAndAliases.envelope, "plain");
    assert.equal(res.checks.envelopeAndAliases.aliases.idField, "service");
    assert.equal(res.checks.envelopeAndAliases.aliases.categoryField, "category");
    assert.equal(res.checks.envelopeAndAliases.aliases.descriptionField, "description");

    // (5) suggested profile name and connection snippet
    assert.equal(res.checks.suggestion.suggestedProfile, "standard");
    assert.deepEqual(res.checks.suggestion.snippet, {
      type: "smm-v2",
      baseUrl: "https://panel.example/api/v2",
      profile: "standard",
    });

    // Formatted report includes key elements
    const report = formatDoctorReport(res);
    assert.match(report, /ALL CHECKS PASSED/);
    assert.match(report, /Balance: 142\.50/);
    assert.match(report, /Catalog size: 2 services/);
    assert.match(report, /"profile": "standard"/);
  });

  it("detects HTML / Cloudflare challenge response", async () => {
    const fetchImpl = (async () => {
      return new Response(
        "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare Ray ID: cf-12345678</body></html>",
        {
          status: 403,
          headers: {
            "content-type": "text/html; charset=UTF-8",
            server: "cloudflare",
            "cf-ray": "cf-12345678-LAX",
          },
        },
      );
    }) as typeof fetch;

    const res = await diagnoseProvider({
      url: "https://cf-blocked.example/api/v2",
      key: "secret-test-key",
      fetchImpl,
    });

    assert.equal(res.ok, false);
    assert.equal(res.checks.reachability.ok, false);
    assert.equal(res.checks.reachability.isHtmlOrCloudflare, true);
    assert.equal(res.checks.reachability.isJson, false);
    assert.match(res.checks.reachability.details, /Cloudflare/i);

    const report = formatDoctorReport(res);
    assert.match(report, /PRE-ONBOARDING CHECK FAILED/);
    assert.match(report, /Cloudflare challenge or HTML response detected/);
  });

  it("detects wrapped envelope and extracts catalog size and items", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const action = body.get("action");

      if (action === "balance") {
        return new Response(JSON.stringify({ balance: "50.00", currency: "USD" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (action === "services") {
        // Services wrapped in an object { services: [...] }
        return new Response(
          JSON.stringify({
            services: [
              { service: 1, name: "Service A", category: "General", rate: "1.00" },
              { service: 2, name: "Service B", category: "General", rate: "2.00" },
              { service: 3, name: "Service C", category: "General", rate: "3.00" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
    }) as typeof fetch;

    const res = await diagnoseProvider({
      url: "https://wrapped-panel.example/api/v2",
      key: "secret-test-key",
      fetchImpl,
    });

    assert.equal(res.ok, true);
    assert.equal(res.checks.envelopeAndAliases.envelope, "wrapped");
    assert.equal(res.checks.envelopeAndAliases.wrapperKey, "services");
    assert.equal(res.checks.services.catalogSize, 3);
    assert.equal(res.checks.envelopeAndAliases.aliases.idField, "service");

    const report = formatDoctorReport(res);
    assert.match(report, /Envelope: wrapped \(wrapper key: 'services'\)/);
  });

  it("detects field aliases (services vs service, Category vs category, desc vs description)", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const action = body.get("action");

      if (action === "balance") {
        return new Response(JSON.stringify({ balance: "99.00", currency: "USD" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (action === "services") {
        // Alias-style services list: services, Category, desc
        return new Response(
          JSON.stringify([
            {
              services: 9005,
              name: "SEO Backlinks",
              Category: "SEO Services",
              desc: "Contextual high DA backlinks",
              rate: "4.50",
              min: 10,
              max: 1000,
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
    }) as typeof fetch;

    const res = await diagnoseProvider({
      url: "https://alias-style.example/api/v2",
      key: "secret-test-key",
      fetchImpl,
    });

    assert.equal(res.ok, true);
    assert.equal(res.checks.envelopeAndAliases.aliases.idField, "services");
    assert.equal(res.checks.envelopeAndAliases.aliases.categoryField, "Category");
    assert.equal(res.checks.envelopeAndAliases.aliases.descriptionField, "desc");

    // Because idField is 'services', 'success-message' profile MUST be suggested
    assert.equal(res.checks.suggestion.suggestedProfile, "success-message");
    assert.deepEqual(res.checks.suggestion.snippet, {
      type: "smm-v2",
      baseUrl: "https://alias-style.example/api/v2",
      profile: "success-message",
    });
  });

  it("suggests extended profile when speed/icon/timelastorders fields are present", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const action = body.get("action");

      if (action === "balance") {
        return new Response(JSON.stringify({ balance: "10.00", currency: "USD" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (action === "services") {
        return new Response(
          JSON.stringify([
            {
              service: 1,
              name: "VK Followers",
              category: "VK",
              rate: "0.50",
              icon: "https://icon.example/vk.png",
              speed: "5000/day",
              timelastorders: "15m",
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
    }) as typeof fetch;

    const res = await diagnoseProvider({
      url: "https://extended-panel.example/api/v2",
      key: "secret-test-key",
      fetchImpl,
    });

    assert.equal(res.ok, true);
    assert.equal(res.checks.suggestion.suggestedProfile, "extended");
    assert.deepEqual(res.checks.envelopeAndAliases.extraFields.sort(), [
      "icon",
      "speed",
      "timelastorders",
    ]);
  });

  it("suggests provider-credits profile when currency is credits/tokens", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const action = body.get("action");

      if (action === "balance") {
        return new Response(JSON.stringify({ balance: "500", currency: "CREDITS" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (action === "services") {
        return new Response(
          JSON.stringify([{ service: 1, name: "Bot Vote", category: "Votes", rate: "1" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
    }) as typeof fetch;

    const res = await diagnoseProvider({
      url: "https://credits-panel.example/api/v2",
      key: "secret-test-key",
      fetchImpl,
    });

    assert.equal(res.ok, true);
    assert.equal(res.checks.suggestion.suggestedProfile, "provider-credits");
  });

  it("handles network failure and timeout gracefully", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;

    const res = await diagnoseProvider({
      url: "https://timeout-panel.example/api/v2",
      key: "secret-test-key",
      fetchImpl,
    });

    assert.equal(res.ok, false);
    assert.equal(res.checks.reachability.ok, false);
    assert.match(res.checks.reachability.details, /timeout/i);
  });

  it("never prints the API key in reports, logs, or error responses", async () => {
    const rawSecretKey = "SUPER_SECRET_KEY_NEVER_PRINT_ME_123456789";
    const loggedOutputs: string[] = [];
    const loggedErrors: string[] = [];

    // Panel returns an error that echoes the API key
    const fetchImpl = (async () => {
      return new Response(
        JSON.stringify({ error: `Invalid API key supplied: ${rawSecretKey}` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const exitCode = await runDoctorCli(
      ["--url", "https://panel.example/api/v2", "--key", rawSecretKey],
      fetchImpl,
      (msg) => loggedOutputs.push(msg),
      (err) => loggedErrors.push(err),
    );

    assert.equal(exitCode, 1);

    const allOutput = loggedOutputs.join("\n") + "\n" + loggedErrors.join("\n");
    assert.equal(allOutput.includes(rawSecretKey), false);
    assert.match(allOutput, /\[REDACTED\]/);
  });

  it("CLI returns exit code 1 when required arguments are missing", async () => {
    const restore = withEnv({
      OPENSMM_PANEL_KEY: undefined,
      OPENSMM_PANEL_URL: undefined,
    });
    const loggedOutputs: string[] = [];
    const loggedErrors: string[] = [];

    try {
      const exitCode = await runDoctorCli(
        ["--url", "https://panel.example/api/v2"],
        undefined,
        (msg) => loggedOutputs.push(msg),
        (err) => loggedErrors.push(err),
      );

      assert.equal(exitCode, 1);
      assert.match(loggedErrors.join("\n"), /Missing required argument/i);
    } finally {
      restore();
    }
  });

  it("CLI returns exit code 0 on full success", async () => {
    const loggedOutputs: string[] = [];
    const loggedErrors: string[] = [];

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const action = body.get("action");

      if (action === "balance") {
        return new Response(JSON.stringify({ balance: "10.00", currency: "USD" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (action === "services") {
        return new Response(
          JSON.stringify([{ service: 1, name: "Followers", category: "IG", rate: "1" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const exitCode = await runDoctorCli(
      ["--url", "https://panel.example/api/v2", "--key", "test-key-abc"],
      fetchImpl,
      (msg) => loggedOutputs.push(msg),
      (err) => loggedErrors.push(err),
    );

    assert.equal(exitCode, 0);
    assert.match(loggedOutputs.join("\n"), /ALL CHECKS PASSED/);
    assert.equal(loggedOutputs.join("\n").includes("test-key-abc"), false);
  });

  /** A panel that answers balance and services and records what it received. */
  function recordingPanel(received: { keys: string[]; urls: string[] }): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      received.urls.push(String(url));
      const body = new URLSearchParams(String(init?.body ?? ""));
      received.keys.push(body.get("key") ?? "");
      const action = body.get("action");
      if (action === "balance") {
        return new Response(JSON.stringify({ balance: "10.00", currency: "USD" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify([{ service: 1, name: "Followers", category: "IG", rate: "1" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  }

  function withEnv(vars: Record<string, string | undefined>): () => void {
    const previous = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
  }

  it("takes the key and the URL from the environment when the flags are absent", async () => {
    const envKey = "ENV_ONLY_SECRET_KEY_987654321";
    const restore = withEnv({
      OPENSMM_PANEL_KEY: envKey,
      OPENSMM_PANEL_URL: "https://env-panel.example/api/v2",
    });
    const received = { keys: [] as string[], urls: [] as string[] };
    const loggedOutputs: string[] = [];
    const loggedErrors: string[] = [];

    try {
      const exitCode = await runDoctorCli(
        [],
        recordingPanel(received),
        (msg) => loggedOutputs.push(msg),
        (err) => loggedErrors.push(err),
      );

      assert.equal(exitCode, 0);
      assert.ok(received.keys.length > 0, "the doctor must reach the panel");
      assert.deepEqual(new Set(received.keys), new Set([envKey]));
      assert.deepEqual(new Set(received.urls), new Set(["https://env-panel.example/api/v2"]));

      const allOutput = loggedOutputs.join("\n") + "\n" + loggedErrors.join("\n");
      assert.equal(allOutput.includes(envKey), false);
      assert.match(allOutput, /ALL CHECKS PASSED/);
    } finally {
      restore();
    }
  });

  it("lets --url and --key override the environment", async () => {
    const restore = withEnv({
      OPENSMM_PANEL_KEY: "ENV_KEY_MUST_NOT_WIN_123",
      OPENSMM_PANEL_URL: "https://env-panel.example/api/v2",
    });
    const received = { keys: [] as string[], urls: [] as string[] };
    const loggedOutputs: string[] = [];
    const loggedErrors: string[] = [];

    try {
      const exitCode = await runDoctorCli(
        [
          "--url",
          "https://flag-panel.example/api/v2",
          "--key",
          "FLAG_KEY_WINS_456",
        ],
        recordingPanel(received),
        (msg) => loggedOutputs.push(msg),
        (err) => loggedErrors.push(err),
      );

      assert.equal(exitCode, 0);
      assert.deepEqual(new Set(received.keys), new Set(["FLAG_KEY_WINS_456"]));
      assert.deepEqual(new Set(received.urls), new Set(["https://flag-panel.example/api/v2"]));

      const allOutput = loggedOutputs.join("\n") + "\n" + loggedErrors.join("\n");
      assert.equal(allOutput.includes("FLAG_KEY_WINS_456"), false);
      assert.equal(allOutput.includes("ENV_KEY_MUST_NOT_WIN_123"), false);
    } finally {
      restore();
    }
  });

  it("returns exit code 1 and names both sources when there is no flag and no environment", async () => {
    const restore = withEnv({
      OPENSMM_PANEL_KEY: undefined,
      OPENSMM_PANEL_URL: undefined,
    });
    const loggedOutputs: string[] = [];
    const loggedErrors: string[] = [];

    try {
      const exitCode = await runDoctorCli(
        [],
        recordingPanel({ keys: [], urls: [] }),
        (msg) => loggedOutputs.push(msg),
        (err) => loggedErrors.push(err),
      );

      assert.equal(exitCode, 1);
      const errors = loggedErrors.join("\n");
      assert.match(errors, /Missing required argument/i);
      assert.match(errors, /--key/);
      assert.match(errors, /OPENSMM_PANEL_KEY/);
      assert.equal(loggedOutputs.join("\n").includes("ALL CHECKS PASSED"), false);
    } finally {
      restore();
    }
  });
});

describe("provider-profile example (docs onboarding entry point)", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const examplePath = path.join(repoRoot, "examples", "provider-profile.example.json");
  const schemaPath = path.join(
    repoRoot,
    "spec",
    "v0",
    "schemas",
    "register-provider-request.json",
  );

  it("satisfies the provider registration schema without any network call", () => {
    // File-only check: no gateway, no panel, no credential is used.
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const profile = JSON.parse(fs.readFileSync(examplePath, "utf8"));

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const applyFormats =
      typeof addFormats === "function" ? addFormats : (addFormats as any).default;
    applyFormats(ajv);

    const validate = ajv.compile(schema);
    assert.equal(
      validate(profile),
      true,
      `provider-profile.example.json failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
    assert.equal(profile.adapter, "rest-v1");
    assert.equal(
      "profile" in profile,
      false,
      "rest-v1 needs no behavior profile: endpoint + apiKey are the connection",
    );
  });

  it("carries no real panel URL and no real API key", () => {
    const raw = fs.readFileSync(examplePath, "utf8");
    const profile = JSON.parse(raw) as { endpoint: string; apiKey: string };

    const host = new URL(profile.endpoint).hostname;
    assert.ok(
      host === "example" || host.endsWith(".example"),
      `endpoint host must be a reserved .example host, got ${host}`,
    );
    assert.match(profile.apiKey, /^REPLACE_WITH_/);
    assert.doesNotMatch(raw, /pk_live|sk_live|Bearer\s+\w/i);
  });
});
