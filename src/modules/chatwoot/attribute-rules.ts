// WHAT A CHATWOOT ATTRIBUTE DEFINITION ACCEPTS, applied by `set_custom_attribute` before it writes.
// The definition is the operator's statement of what the field holds (a list of options, a number, a
// date, a pattern), and the dashboard's own editor enforces it on a person's edit; the API does not,
// so a write from the agent went in as whatever string the model passed. Dependency-free on purpose:
// the tool and the editor's per-attribute rule both read it, and the editor must describe the same
// rule the tool applies.

// The slice of a definition the rule reads. `CustomAttributeDef` (client.ts) carries it whole.
export interface AttributeRuleDef {
  key: string;
  displayType: string;
  values: string[];
  regexPattern: string | null;
  regexCue: string | null;
}

// The rule a refused value broke, as an enum: it goes on the flowlog line and in the test names,
// never the value itself (customer data, docs/logs.md).
export type AttributeRule =
  | "empty"
  | "list"
  | "number"
  | "date"
  | "checkbox"
  | "link"
  | "pattern";

export type AttributeCheck =
  | { ok: true; value: string }
  | { ok: false; rule: AttributeRule };

// Chatwoot's numeric display types. Currency and percent are numbers with a different rendering.
const NUMERIC = new Set(["number", "currency", "percent"]);
const NUMBER_RE = /^[+-]?\d+(\.\d+)?$/;
// A calendar date, or the ISO timestamp the dashboard itself stores for a date attribute.
const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// Chatwoot keeps the pattern as the dashboard wrote it, `/source/flags` (normalizeRegexPattern in
// the fork's Validators.js), and older rows hold the bare source. `g` and `y` are dropped: they make
// `test` stateful, and a rule must answer the same for the same value. Null when it does not compile,
// which the caller treats as a refusal, as the dashboard does.
export function compileAttributePattern(pattern: string): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  const source = m ? (m[1] ?? "") : pattern;
  const flags = (m?.[2] ?? "").replace(/[gy]/g, "");
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function validDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

function validLink(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.host;
  } catch {
    return false;
  }
}

// The value to write, trimmed, or the rule it broke. A blank value is refused here whatever the
// definition says: clearing a field is its own call (`clear`), so an empty string the model passed
// by accident never reads as "the customer answered nothing". With no definition only that rule
// applies: Chatwoot accepts a key it has no definition for, and so does the tool.
export function checkAttributeValue(
  def: AttributeRuleDef | undefined,
  raw: string,
): AttributeCheck {
  const value = raw.trim();
  if (value === "") return { ok: false, rule: "empty" };
  if (!def) return { ok: true, value };
  const type = def.displayType;
  if (type === "list") {
    // Exact, as the dashboard's dropdown can only produce one of the options.
    if (def.values.length > 0 && !def.values.includes(value))
      return { ok: false, rule: "list" };
  } else if (NUMERIC.has(type)) {
    if (!NUMBER_RE.test(value)) return { ok: false, rule: "number" };
  } else if (type === "date") {
    if (!validDate(value)) return { ok: false, rule: "date" };
  } else if (type === "checkbox") {
    // The dashboard renders the string "false" as unchecked and any other value as checked, so the
    // two spellings it understands are the only two written.
    const lower = value.toLowerCase();
    if (lower !== "true" && lower !== "false")
      return { ok: false, rule: "checkbox" };
    return { ok: true, value: lower };
  } else if (type === "link") {
    // NOTE: the dashboard checks a link with its URL validator and skips the pattern, and so does this.
    return validLink(value) ? { ok: true, value } : { ok: false, rule: "link" };
  }
  if (def.regexPattern) {
    const re = compileAttributePattern(def.regexPattern);
    if (!re?.test(value)) return { ok: false, rule: "pattern" };
  }
  return { ok: true, value };
}

// Why `set_custom_attribute` refused a write: outside the agent's list, a value its definition does
// not accept, or a clear that also carried a value. `key` is present only when it is operator
// vocabulary (in the list, or defined in Chatwoot): without a list the model names any key it likes.
export interface AttributeRefusal {
  scope: "conversation" | "contact" | "task";
  rule: AttributeRule | "not_allowed" | "clear_with_value";
  key?: string;
}
export type AttributeRefusalReporter = (refusal: AttributeRefusal) => void;
