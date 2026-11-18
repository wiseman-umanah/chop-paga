/**
 * Paga helpers — hashing, reference format, amount conversion and the
 * Business API response-code classification that decides whether a payout
 * may be retried. Source: convex/paga.ts
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  classifyPagaResponseCode,
  hashesEqual,
  koboToNaira,
  nairaToKobo,
  pagaHash,
  pagaReference,
} from "../../convex/paga";

describe("pagaHash", () => {
  it("is sha512 hex of the concatenated values followed by the hash key", async () => {
    const expected = createHash("sha512").update("10.002025-08-26T13:36:04CHP-ABCsecret").digest("hex");
    expect(await pagaHash(["10.00", "2025-08-26T13:36:04", "CHP-ABC"], "secret")).toBe(expected);
  });

  it("treats null and undefined as empty strings", async () => {
    const expected = createHash("sha512").update("REFkey").digest("hex");
    expect(await pagaHash(["REF", null, undefined], "key")).toBe(expected);
  });
});

describe("hashesEqual", () => {
  it("compares case-insensitively", () => {
    expect(hashesEqual("ABCdef", "abcDEF")).toBe(true);
  });
  it("rejects different values and lengths", () => {
    expect(hashesEqual("abc", "abd")).toBe(false);
    expect(hashesEqual("abc", "abcd")).toBe(false);
  });
});

describe("amount conversion", () => {
  it("kobo → naira string with two decimals", () => {
    expect(koboToNaira(75_000)).toBe("750.00");
    expect(koboToNaira(101_523)).toBe("1015.23");
  });
  it("naira → kobo, rounding float noise", () => {
    expect(nairaToKobo("1015.23")).toBe(101_523);
    expect(nairaToKobo(5000.0)).toBe(500_000);
    expect(nairaToKobo("")).toBeUndefined();
    expect(nairaToKobo("abc")).toBeUndefined();
  });
});

describe("pagaReference", () => {
  it("is prefixed, uppercase and within Paga's 50-char limit", () => {
    const ref = pagaReference("CPO");
    expect(ref).toMatch(/^CPO-[0-9A-F]{12}$/);
    expect(ref.length).toBeLessThanOrEqual(50);
  });
  it("is unique per call", () => {
    expect(pagaReference("CHP")).not.toBe(pagaReference("CHP"));
  });
});

describe("classifyPagaResponseCode", () => {
  it("0 is success, 3 is pending", () => {
    expect(classifyPagaResponseCode(0)).toBe("success");
    expect(classifyPagaResponseCode("0")).toBe("success");
    expect(classifyPagaResponseCode(3)).toBe("pending");
  });

  it("-1, 105, 135, unlisted codes and missing codes are unknown — never retried with a new reference", () => {
    for (const code of [-1, 105, 135, 999, null, undefined]) {
      expect(classifyPagaResponseCode(code)).toBe("unknown");
    }
  });

  it("documented rejections are failures", () => {
    for (const code of [4, 101, 115, 116, 139, 140]) {
      expect(classifyPagaResponseCode(code)).toBe("failed");
    }
  });
});
