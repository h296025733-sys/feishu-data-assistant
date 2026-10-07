import { describe, expect, it } from "vitest";
import { avatarProfileHandle } from "../src/creators/avatar-profile.js";

describe("avatar profile identity parsing", () => {
  it("accepts ordinary links and Feishu formula cells", () => {
    expect(avatarProfileHandle({ link: "https://www.tiktok.com/@Creator.One", text: "display" })).toBe("creator.one");
    expect(avatarProfileHandle([{ text: "https://www.tiktok.com/@creator_one" }])).toBe("creator_one");
  });
  it("tolerates leading newline and invisible formatting without changing source", () => {
    const source = [{ text: "https://www.tiktok.com/@\u2063\ncreator_one" }];
    const before = JSON.stringify(source);
    expect(avatarProfileHandle(source)).toBe("creator_one");
    expect(JSON.stringify(source)).toBe(before);
  });
  it("accepts profile suffixes", () => {
    expect(avatarProfileHandle("https://www.tiktok.com/@creator_one/?lang=en#profile")).toBe("creator_one");
  });
  it("accepts a trailing pasted object marker without modifying the source", () => {
    const source = { text: "https://www.tiktok.com/@\nmarib679\n\uFFFC", type: "text" };
    const before = JSON.stringify(source);
    expect(avatarProfileHandle(source)).toBe("marib679");
    expect(JSON.stringify(source)).toBe(before);
    expect(avatarProfileHandle("https://www.tiktok.com/@foo\uFFFCbar")).toBeNull();
    expect(avatarProfileHandle("https://www.tiktok.com/@foo bar\uFFFC")).toBeNull();
  });
  it("rejects another host, video links, empty and split handles", () => {
    for (const value of [null, "https://tiktok.com.evil/@creator", "https://www.tiktok.com/@", "https://www.tiktok.com/@foo bar", "https://www.tiktok.com/@foo/video/123"]) {
      expect(avatarProfileHandle(value)).toBeNull();
    }
  });
});
