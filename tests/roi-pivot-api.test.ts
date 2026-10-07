import { describe, expect, it } from "vitest";
import {
  RoiPivotClientTokens,
  fixedMetricFormulaExpression,
  sameViewFilter,
  selectMainGridView,
} from "../src/feishu/roi-pivot-api.js";

describe("RoiPivotClientTokens", () => {
  it("reuses a token for an identical retry regardless of object key order", () => {
    const tokens = new RoiPivotClientTokens();
    const first = tokens.get("roi-pivot-create", [{ fields: { b: 2, a: 1 } }]);
    const retry = tokens.get("roi-pivot-create", [{ fields: { a: 1, b: 2 } }]);

    expect(retry).toBe(first);
  });

  it("rotates tokens after a verified mutation cycle", () => {
    const tokens = new RoiPivotClientTokens();
    const first = tokens.get("roi-pivot-update", ["record-1"]);

    tokens.clear();

    expect(tokens.get("roi-pivot-update", ["record-1"])).not.toBe(first);
  });
});

describe("ROI main grid view configuration", () => {
  it("selects the uniquely named grid view without touching dashboards", () => {
    expect(selectMainGridView([
      { view_id: "dashboard", view_name: "投产比总览", view_type: "dashboard" },
      { view_id: "grid", view_name: "表格", view_type: "grid" },
    ])).toMatchObject({ view_id: "grid" });
  });

  it("compares filters without depending on condition order or generated ids", () => {
    const expected = {
      conjunction: "or" as const,
      conditions: [
        { field_id: "role", operator: "isEmpty" },
        { field_id: "role", operator: "is", value: "[\"input-template\"]" },
      ],
    };
    expect(sameViewFilter({
      conjunction: "or",
      conditions: [
        { field_id: "role", operator: "is", value: "[\"input-template\"]" },
        { field_id: "role", operator: "isEmpty", value: null },
      ],
    }, expected)).toBe(true);
  });

  it("builds a read-only metric formula that keeps the existing visible field in place", () => {
    expect(fixedMetricFormulaExpression("table-1", "metric-code")).toBe(
      "bitable::$table[table-1].$field[metric-code]",
    );
  });
});
