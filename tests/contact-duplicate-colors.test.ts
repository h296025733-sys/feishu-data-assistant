import { describe, expect, it } from "vitest";
import {
  DUPLICATE_CONTACT_COLOR,
  UNIQUE_CONTACT_COLOR,
  buildContactColorPlan,
  contactCellToString,
  normalizeContact,
} from "../src/feishu/contact-duplicate-colors.js";

describe("normalizeContact", () => {
  it("normalizes email case, whitespace and invisible characters", () => {
    expect(normalizeContact(" \u200bTEST@EXAMPLE.COM ")).toBe(
      "test@example.com",
    );
  });

  it("normalizes common phone punctuation", () => {
    expect(normalizeContact("+1 (202) 555-0101")).toBe("+12025550101");
    expect(normalizeContact("WhatsApp +1 (202) 555-0102")).toBe("+12025550102");
  });
});

describe("contactCellToString", () => {
  it("reads Feishu text segments and single-select values", () => {
    expect(contactCellToString([{ type: "text", text: "a@" }, { type: "text", text: "b.com" }]))
      .toBe("a@b.com");
    expect(contactCellToString("a@b.com")).toBe("a@b.com");
  });
});

describe("buildContactColorPlan", () => {
  it("colors all normalized duplicates red and keeps unused options", () => {
    const plan = buildContactColorPlan(
      [
        { recordId: "1", value: "Test@Example.com" },
        { recordId: "2", value: " test@example.com " },
        { recordId: "3", value: "+1 (202) 555-0101" },
        { recordId: "4", value: "" },
      ],
      [
        { id: "old-email", name: "Test@Example.com", color: 0 },
        { id: "stale", name: "unused@example.com", color: 3 },
      ],
    );

    expect(plan.duplicateGroups).toBe(1);
    expect(plan.duplicateRecords).toBe(2);
    expect(plan.nonblankRecords).toBe(3);
    expect(plan.addedOptions).toBe(2);
    expect(plan.options).toContainEqual({
      id: "old-email",
      name: "Test@Example.com",
      color: DUPLICATE_CONTACT_COLOR,
    });
    expect(plan.options).toContainEqual({
      id: "stale",
      name: "unused@example.com",
      color: UNIQUE_CONTACT_COLOR,
    });
    expect(plan.options).toContainEqual({
      name: "test@example.com",
      color: DUPLICATE_CONTACT_COLOR,
    });
  });
});
