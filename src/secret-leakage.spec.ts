import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { PraesidiaClient } from "./client.js";
import { PraesidiaGuard } from "./guard.js";
import { PraesidiaTelemetry } from "./telemetry.js";

/**
 * SCAN2-013/CT-10 — TypeScript's `private` modifier is compile-time only; at
 * runtime an `apiKey` field declared `private apiKey: string` is a perfectly
 * normal, own-enumerable instance property. `console.log(instance)`,
 * `util.inspect(instance)`, `JSON.stringify(instance)`, a snapshot test, or
 * an error-tracking SDK serializing the object graph on an uncaught
 * exception all print/transmit the raw key in cleartext. These tests
 * construct each credential-holding class with a sentinel key and assert
 * the sentinel is absent from all three serialization surfaces AND from
 * `Object.keys`/`Object.getOwnPropertyNames` enumeration.
 */
const SENTINEL_KEY = "sk_live_SENTINEL_DO_NOT_LEAK_0000000000";

function assertKeyNotEnumerableOrSerializable(instance: object, key: string): void {
  expect(JSON.stringify(instance)).not.toContain(key);
  expect(inspect(instance, { depth: null })).not.toContain(key);
  expect(Object.keys(instance)).not.toContain(key);
  // Any own-enumerable OR own-non-enumerable property whose VALUE is the
  // sentinel — catches a rename to a differently-named-but-still-plain field.
  for (const propName of Object.getOwnPropertyNames(instance)) {
    const value = (instance as Record<string, unknown>)[propName];
    expect(value).not.toBe(key);
  }
}

describe("API key is not runtime-enumerable or serializable (SCAN2-013)", () => {
  it("PraesidiaClient never exposes the configured API key", () => {
    const client = new PraesidiaClient(
      "https://api.example.test",
      SENTINEL_KEY,
    );
    assertKeyNotEnumerableOrSerializable(client, SENTINEL_KEY);
  });

  it("PraesidiaClient never exposes the key after setApiKey() rotation either", () => {
    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_initial",
    );
    client.setApiKey(SENTINEL_KEY);
    assertKeyNotEnumerableOrSerializable(client, SENTINEL_KEY);
  });

  it("PraesidiaGuard never exposes the configured API key", () => {
    const guard = new PraesidiaGuard({
      apiKey: SENTINEL_KEY,
      orgId: "org-1",
      baseUrl: "https://api.example.test",
    });
    assertKeyNotEnumerableOrSerializable(guard, SENTINEL_KEY);
  });

  it("PraesidiaTelemetry never exposes the configured API key", () => {
    const telemetry = new PraesidiaTelemetry({
      apiKey: SENTINEL_KEY,
      orgId: "org-1",
      baseUrl: "https://api.example.test",
    });
    assertKeyNotEnumerableOrSerializable(telemetry, SENTINEL_KEY);
  });
});
