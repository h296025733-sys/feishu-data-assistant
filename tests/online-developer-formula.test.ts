import { describe, expect, it } from "vitest";
import { buildOnlineDeveloperFormula } from "../src/feishu/online-developer-formula.js";
import {
  buildOnlineCooperationLookupFormula,
  normalizeHandleFormula,
} from "../src/feishu/handle-formula.js";

describe("creator lookup formulas", () => {
  it("normalizes duplicate markers, line breaks, tabs, spaces, @ and casing", () => {
    const expression = normalizeHandleFormula("creator");
    expect(expression).toContain('SUBSTITUTE(creator,"⁣","")');
    expect(expression).toContain("CHAR(10)");
    expect(expression).toContain("CHAR(13)");
    expect(expression).toContain("CHAR(9)");
    expect(expression).toContain('"@",""');
    expect(expression.startsWith("LOWER(")).toBe(true);
  });

  it("applies the documented developer owner priority", () => {
    const expression = buildOnlineDeveloperFormula({
      developmentTableId: "dev",
      onlineTableId: "online",
      developmentCreatorFieldId: "devCreator",
      developmentFinalOwnerFieldId: "finalOwner",
      developmentSecondOwnerFieldId: "owner2",
      developmentFirstOwnerFieldId: "owner1",
      onlineCreatorFieldId: "onlineCreator",
    });

    expect(expression).toContain("CHAR(10)");
    expect(expression.indexOf(".$column[finalOwner].FIRST()"))
      .toBeLessThan(expression.indexOf(".$column[owner2].FIRST()"));
    expect(expression.indexOf(".$column[owner2].FIRST()"))
      .toBeLessThan(expression.indexOf(".$column[owner1].FIRST()"));
  });

  it("uses the same normalization on both sides of a cooperation lookup", () => {
    const expression = buildOnlineCooperationLookupFormula({
      cooperationTableId: "cooperation",
      onlineTableId: "online",
      cooperationCreatorFieldId: "cooperationCreator",
      cooperationValueFieldId: "followers",
      onlineCreatorFieldId: "onlineCreator",
    });
    expect(expression).toContain("bitable::$table[cooperation].FILTER(");
    expect(expression).toContain(".$column[followers].FIRST()");
    expect(expression.match(/CHAR\(10\)/g)).toHaveLength(3);
  });
});
