import { describe, expect, test } from "bun:test";
import {
  type AttributeRuleDef,
  checkAttributeValue,
  compileAttributePattern,
} from "@/modules/chatwoot/attribute-rules";

const def = (over: Partial<AttributeRuleDef>): AttributeRuleDef => ({
  key: "k",
  displayType: "text",
  values: [],
  regexPattern: null,
  regexCue: null,
  ...over,
});

describe("checkAttributeValue", () => {
  test("a blank value is refused with or without a definition", () => {
    expect(checkAttributeValue(undefined, "")).toEqual({
      ok: false,
      rule: "empty",
    });
    expect(checkAttributeValue(def({}), "   ")).toEqual({
      ok: false,
      rule: "empty",
    });
  });

  test("a key without a definition takes any non-blank value, trimmed", () => {
    expect(checkAttributeValue(undefined, "  Oi  ")).toEqual({
      ok: true,
      value: "Oi",
    });
  });

  test("a list takes only one of its options, spelled exactly", () => {
    const d = def({ displayType: "list", values: ["Infantil", "Fundamental"] });
    expect(checkAttributeValue(d, "Fundamental")).toEqual({
      ok: true,
      value: "Fundamental",
    });
    expect(checkAttributeValue(d, "fundamental")).toEqual({
      ok: false,
      rule: "list",
    });
    expect(checkAttributeValue(d, "5º ano")).toEqual({
      ok: false,
      rule: "list",
    });
  });

  test("number, currency and percent take digits with an optional decimal point", () => {
    for (const displayType of ["number", "currency", "percent"]) {
      const d = def({ displayType });
      expect(checkAttributeValue(d, "1500")).toEqual({
        ok: true,
        value: "1500",
      });
      expect(checkAttributeValue(d, "-12.5")).toEqual({
        ok: true,
        value: "-12.5",
      });
      expect(checkAttributeValue(d, "mil e quinhentos")).toEqual({
        ok: false,
        rule: "number",
      });
      expect(checkAttributeValue(d, "12,5")).toEqual({
        ok: false,
        rule: "number",
      });
    }
  });

  test("a date takes a real calendar date as YYYY-MM-DD, or the ISO timestamp Chatwoot stores", () => {
    const d = def({ displayType: "date" });
    expect(checkAttributeValue(d, "2026-10-20")).toEqual({
      ok: true,
      value: "2026-10-20",
    });
    expect(checkAttributeValue(d, "2026-10-20T03:00:00.000Z")).toEqual({
      ok: true,
      value: "2026-10-20T03:00:00.000Z",
    });
    expect(checkAttributeValue(d, "2026-02-30")).toEqual({
      ok: false,
      rule: "date",
    });
    expect(checkAttributeValue(d, "20/10/2026")).toEqual({
      ok: false,
      rule: "date",
    });
    expect(checkAttributeValue(d, "amanhã")).toEqual({
      ok: false,
      rule: "date",
    });
  });

  test("a checkbox takes true or false, written lowercase", () => {
    const d = def({ displayType: "checkbox" });
    expect(checkAttributeValue(d, "TRUE")).toEqual({ ok: true, value: "true" });
    expect(checkAttributeValue(d, "false")).toEqual({
      ok: true,
      value: "false",
    });
    expect(checkAttributeValue(d, "sim")).toEqual({
      ok: false,
      rule: "checkbox",
    });
  });

  test("a link takes an http(s) URL and skips the pattern, as the dashboard does", () => {
    const d = def({ displayType: "link", regexPattern: "/^never$/" });
    expect(checkAttributeValue(d, "https://exemplo.com/a")).toEqual({
      ok: true,
      value: "https://exemplo.com/a",
    });
    expect(checkAttributeValue(d, "exemplo.com")).toEqual({
      ok: false,
      rule: "link",
    });
    expect(checkAttributeValue(d, "ftp://exemplo.com/a")).toEqual({
      ok: false,
      rule: "link",
    });
    expect(checkAttributeValue(d, "javascript:alert(1)")).toEqual({
      ok: false,
      rule: "link",
    });
  });

  test("the pattern holds a text value back, in the /source/flags form Chatwoot stores", () => {
    const d = def({
      regexPattern: "/^(?!(oi|bom dia|tudo bem)$)[a-zà-ú ]{2,}$/i",
      regexCue: "Nome da pessoa",
    });
    expect(checkAttributeValue(d, "Maria Souza")).toEqual({
      ok: true,
      value: "Maria Souza",
    });
    expect(checkAttributeValue(d, "Oi")).toEqual({
      ok: false,
      rule: "pattern",
    });
    expect(checkAttributeValue(d, "Bom dia")).toEqual({
      ok: false,
      rule: "pattern",
    });
  });

  test("a pattern that does not compile refuses, as the dashboard does", () => {
    const d = def({ regexPattern: "/([a-z/" });
    expect(checkAttributeValue(d, "qualquer")).toEqual({
      ok: false,
      rule: "pattern",
    });
  });
});

describe("compileAttributePattern", () => {
  test("reads the bare source of an older row too", () => {
    expect(compileAttributePattern("^\\d+$")?.test("123")).toBe(true);
  });

  test("drops g and y, so the same value answers the same every time", () => {
    const re = compileAttributePattern("/^a$/gy");
    expect(re?.flags).toBe("");
    expect(re?.test("a")).toBe(true);
    expect(re?.test("a")).toBe(true);
  });
});
