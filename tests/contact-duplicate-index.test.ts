import { describe, expect, it } from "vitest";
import {
  ContactCountIndex,
  collectContactRecordChanges,
} from "../src/feishu/contact-duplicate-index.js";
import {
  DUPLICATE_CONTACT_COLOR,
  UNIQUE_CONTACT_COLOR,
  buildIncrementalContactColorPlan,
  normalizeContact,
} from "../src/feishu/contact-duplicate-colors.js";

describe("ContactCountIndex", () => {
  it("applies 100 simultaneous additions and deletions without rescanning", () => {
    const index = new ContactCountIndex(normalizeContact);
    index.reset([{ recordId: "seed", value: "same@example.com" }]);

    const additions = Array.from({ length: 100 }, (_, indexValue) => ({
      recordId: `new-${indexValue}`,
      value: " SAME@example.com ",
    }));
    const added = index.apply(additions);

    expect(added.changedRecords).toBe(100);
    expect(added.impactedNormalizedValues).toEqual(new Set(["same@example.com"]));
    expect(index.stats()).toMatchObject({
      totalRecords: 101,
      nonblankRecords: 101,
      duplicateGroups: 1,
      duplicateRecords: 101,
    });

    const deleted = index.apply(additions.map((record) => ({
      recordId: record.recordId,
      value: null,
    })));
    expect(deleted.changedRecords).toBe(100);
    expect(index.stats()).toMatchObject({
      totalRecords: 1,
      nonblankRecords: 1,
      duplicateGroups: 0,
      duplicateRecords: 0,
    });
  });
});

describe("collectContactRecordChanges", () => {
  it("coalesces 100 lifecycle actions and ignores unrelated edits", () => {
    const lifecycle = collectContactRecordChanges({
      action_list: Array.from({ length: 100 }, (_, index) => ({
        record_id: `rec-${index}`,
        action: "record_added",
        after_value: [],
      })),
    }, "contact-field");
    expect(lifecycle.recordIds.size).toBe(100);
    expect(lifecycle.requiresFullReconciliation).toBe(false);

    const unrelated = collectContactRecordChanges({
      action_list: [{
        record_id: "unrelated",
        action: "record_edited",
        before_value: [{ field_id: "another-field" }],
        after_value: [{ field_id: "another-field" }],
      }],
    }, "contact-field");
    expect(unrelated.recordIds.size).toBe(0);
    expect(unrelated.requiresFullReconciliation).toBe(false);

    const malformed = collectContactRecordChanges({
      action_list: [{ action: "record_deleted", before_value: [] }],
    }, "contact-field");
    expect(malformed.requiresFullReconciliation).toBe(true);
  });
});

describe("buildIncrementalContactColorPlan", () => {
  it("changes only impacted groups and preserves unrelated option metadata", () => {
    const index = new ContactCountIndex(normalizeContact);
    index.reset([
      { recordId: "1", value: "Test@Example.com" },
      { recordId: "2", value: " test@example.com " },
      { recordId: "3", value: "untouched@example.com" },
    ]);

    const plan = buildIncrementalContactColorPlan(
      index,
      new Set(["test@example.com"]),
      new Set(),
      [
        { id: "a", name: "Test@Example.com", color: UNIQUE_CONTACT_COLOR },
        { id: "b", name: "test@example.com", color: UNIQUE_CONTACT_COLOR },
        { id: "c", name: "untouched@example.com", color: 7 },
      ],
    );

    expect(plan.changedOptions).toBe(2);
    expect(plan.options).toContainEqual({
      id: "a",
      name: "Test@Example.com",
      color: DUPLICATE_CONTACT_COLOR,
    });
    expect(plan.options).toContainEqual({
      id: "b",
      name: "test@example.com",
      color: DUPLICATE_CONTACT_COLOR,
    });
    expect(plan.options).toContainEqual({
      id: "c",
      name: "untouched@example.com",
      color: 7,
    });

    index.apply([{ recordId: "2", value: null }]);
    const reverted = buildIncrementalContactColorPlan(
      index,
      new Set(["test@example.com"]),
      new Set(),
      plan.options,
    );
    expect(reverted.options.filter((option) => (
      normalizeContact(option.name) === "test@example.com"
    ))).toEqual([
      { id: "a", name: "Test@Example.com", color: UNIQUE_CONTACT_COLOR },
      { id: "b", name: "test@example.com", color: UNIQUE_CONTACT_COLOR },
    ]);
  });
});
