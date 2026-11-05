import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

describe("spec and examples agreement", () => {
  const schemasDir = path.resolve(import.meta.dirname, "../spec/v0/schemas");
  const examplesDir = path.resolve(import.meta.dirname, "../spec/v0/examples");

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const applyFormats = typeof addFormats === "function" ? addFormats : (addFormats as any).default;
  applyFormats(ajv);

  const schemaFiles = fs.readdirSync(schemasDir).filter((f) => f.endsWith(".json")).sort();
  const schemaIdByFile = new Map<string, string>();

  // Load all schemas from disk and register them by their $id
  for (const file of schemaFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
    if (!raw.$id) {
      throw new Error(`Schema file ${file} is missing required $id`);
    }
    ajv.addSchema(raw, raw.$id);
    schemaIdByFile.set(file, raw.$id);
    schemaIdByFile.set(file.replace(/\.json$/, ""), raw.$id);
  }

  function readExample(fileName: string): any {
    const fullPath = path.join(examplesDir, fileName);
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  }

  function assertValid(schemaNameOrId: string, data: unknown, context: string): void {
    const schemaId = schemaNameOrId.startsWith("http")
      ? schemaNameOrId
      : schemaIdByFile.get(schemaNameOrId) ??
        schemaIdByFile.get(schemaNameOrId.endsWith(".json") ? schemaNameOrId : `${schemaNameOrId}.json`);

    assert.ok(schemaId, `Unknown schema reference: ${schemaNameOrId}`);
    const validate = ajv.getSchema(schemaId);
    assert.ok(validate, `Compiled schema not found for $id: ${schemaId}`);

    const valid = validate(data);
    if (!valid) {
      const details = JSON.stringify(validate.errors, null, 2);
      assert.fail(`Payload for ${context} failed schema validation (${schemaId}):\n${details}`);
    }
  }

  it("loads and registers all 12 spec schemas by their $id", () => {
    assert.ok(schemaFiles.length >= 12, `Expected at least 12 schemas, found ${schemaFiles.length}`);
    for (const file of schemaFiles) {
      const id = schemaIdByFile.get(file);
      assert.ok(id, `Schema id must exist for ${file}`);
      assert.ok(ajv.getSchema(id), `Ajv must resolve compiled schema for ${id}`);
    }
  });

  it("schemas cross-reference each other via relative $ref (e.g. money.json)", () => {
    const orderSchemaId = schemaIdByFile.get("order.json")!;
    const validate = ajv.getSchema(orderSchemaId);
    assert.ok(validate, "Order validator must exist");

    // Valid order
    const validOrder = readExample("05-order-completed.json").response;
    assert.equal(validate(validOrder), true);

    // Negative check: corrupt amount inside money.json ref
    const invalidOrder = {
      ...validOrder,
      amount: { value: "not-a-decimal", currency: "USDC" },
    };
    assert.equal(validate(invalidOrder), false, "Relative $ref to money.json should reject non-decimal value");
  });

  it("00-capabilities.json satisfies capabilities.json", () => {
    const ex00 = readExample("00-capabilities.json");
    const payload = ex00.response ?? ex00;
    assertValid("capabilities.json", payload, "00-capabilities.json");
  });

  it("01-search-services.json response.services[] satisfies service.json", () => {
    const ex01 = readExample("01-search-services.json");
    assert.ok(Array.isArray(ex01.response?.services), "01-search-services.json must have response.services array");
    assert.ok(ex01.response.services.length > 0, "response.services array must not be empty");
    for (let i = 0; i < ex01.response.services.length; i++) {
      assertValid("service.json", ex01.response.services[i], `01-search-services.json response.services[${i}]`);
    }
  });

  it("02-quote.json response satisfies quote.json and requestBody satisfies create-quote-request.json", () => {
    const ex02 = readExample("02-quote.json");
    assertValid("quote.json", ex02.response, "02-quote.json response");
    assert.ok(ex02.requestBody, "02-quote.json must have requestBody");
    assertValid("create-quote-request.json", ex02.requestBody, "02-quote.json requestBody");
  });

  it("03-create-order-requires-payment.json response satisfies order.json and requestBody satisfies create-order-request.json", () => {
    const ex03 = readExample("03-create-order-requires-payment.json");
    assertValid("order.json", ex03.response, "03-create-order-requires-payment.json response");
    assert.ok(ex03.requestBody, "03-create-order-requires-payment.json must have requestBody");
    assertValid("create-order-request.json", ex03.requestBody, "03-create-order-requires-payment.json requestBody");
  });

  it("04-payment-settled.json response satisfies payment-intent.json", () => {
    const ex04 = readExample("04-payment-settled.json");
    const payload = ex04.response ?? ex04;
    assertValid("payment-intent.json", payload, "04-payment-settled.json response");
  });

  it("05-order-completed.json response satisfies order.json", () => {
    const ex05 = readExample("05-order-completed.json");
    const payload = ex05.response ?? ex05;
    assertValid("order.json", payload, "05-order-completed.json response");
  });

  it("06-providers.json response.providers[] satisfies provider-info.json", () => {
    const ex06 = readExample("06-providers.json");
    assert.ok(Array.isArray(ex06.response?.providers), "06-providers.json must have response.providers array");
    assert.ok(ex06.response.providers.length > 0, "response.providers array must not be empty");
    for (let i = 0; i < ex06.response.providers.length; i++) {
      assertValid("provider-info.json", ex06.response.providers[i], `06-providers.json response.providers[${i}]`);
    }
  });

  it("07-register-provider.json request/response satisfy their schemas", () => {
    const ex07 = readExample("07-register-provider.json");
    assertValid("register-provider-request.json", ex07.requestBody, "07-register-provider.json requestBody");
    assertValid("register-provider-response.json", ex07.response, "07-register-provider.json response");
  });

  it("covers every example file in spec/v0/examples/*.json", () => {
    const expected = [
      "00-capabilities.json",
      "01-search-services.json",
      "02-quote.json",
      "03-create-order-requires-payment.json",
      "04-payment-settled.json",
      "05-order-completed.json",
      "06-providers.json",
      "07-register-provider.json",
    ];
    const actual = fs.readdirSync(examplesDir).filter((f) => f.endsWith(".json")).sort();
    assert.deepEqual(actual, expected.sort(), "All example files must be recognized and covered");
  });
});
