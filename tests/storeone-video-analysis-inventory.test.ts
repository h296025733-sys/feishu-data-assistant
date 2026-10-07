import { describe, expect, it } from "vitest";
import { buildStoreoneVideoInventory, buildStoreVideoInventory, excludePreviouslyComplete,
  STOREONE_VIDEO_TABLES, STORETWO_VIDEO_TABLES,
  prioritizeObservedVideos } from "../src/video-analysis/storeone-inventory.js";

describe("STOREONE video analysis inventory", () => {
  it("distinguishes completed, partial, duplicate and invalid rows without overwriting any", () => {
    const url = (id: string) => `https://www.tiktok.com/@creator/video/${id}`;
    const inventory = buildStoreoneVideoInventory({
      [STOREONE_VIDEO_TABLES.online]: [
        { record_id: "new", fields: { 视频上线地址: { link: url("7684496481503431949") }, "实上线日期(Ct)": 1800 } },
        { record_id: "new-duplicate", fields: { 视频上线地址: url("7684496481503431949") } },
        { record_id: "old", fields: { 视频上线地址: url("7683465153769131295"), "实上线日期(Ct)": 1000 } },
        { record_id: "partial", fields: { 视频上线地址: url("7683752813444222222"), 视频内容分析: "手工内容" } },
        { record_id: "blank", fields: { 视频上线地址: "" } },
      ],
      [STOREONE_VIDEO_TABLES.account]: [
        { record_id: "complete", fields: { 视频ID网址: url("7684187473198501150"), 视频内容分析: "A", 投广建议: "待选投广", 视频修改建议: "B" } },
        { record_id: "same-id-different-table", fields: { 视频ID网址: url("7683465153769131295"), 发布时间: 2000 } },
      ],
    });
    expect(inventory.totalRows).toBe(7);
    expect(inventory.completeRows).toBe(1);
    expect(inventory.completeKeys).toEqual([`${STOREONE_VIDEO_TABLES.account}:7684187473198501150`]);
    expect(inventory.partial.map((x) => x.recordId)).toEqual(["partial"]);
    expect(inventory.invalid.map((x) => x.recordId)).toEqual(["blank"]);
    expect(inventory.duplicates).toEqual([{ key: `${STOREONE_VIDEO_TABLES.online}:7684496481503431949`, recordIds: ["new", "new-duplicate"] }]);
    expect(inventory.pending.map((x) => x.recordId)).toEqual(["same-id-different-table", "old"]);
  });

  it("takes newly observed Base videos first even when their publication date is older", () => {
    const url = (id: string) => `https://www.tiktok.com/@creator/video/${id}`;
    const inventory = buildStoreoneVideoInventory({
      [STOREONE_VIDEO_TABLES.online]: [
        { record_id: "old-backlog", fields: { 视频上线地址: url("7684496481503431949"), "实上线日期(Ct)": 3000 } },
        { record_id: "added-today", fields: { 视频上线地址: url("7683465153769131295"), "实上线日期(Ct)": 1000 } },
      ],
      [STOREONE_VIDEO_TABLES.account]: [],
    });
    const [oldVideo, newVideo] = inventory.pending;
    expect(prioritizeObservedVideos(inventory.pending, {
      [oldVideo.key]: 1000,
      [newVideo.key]: 2000,
    }).map((item) => item.recordId)).toEqual(["added-today", "old-backlog"]);
  });

  it("does not refill a once-complete video after someone clears its three analysis cells", () => {
    const url = "https://www.tiktok.com/@creator/video/7684496481503431949";
    const inventory = buildStoreoneVideoInventory({
      [STOREONE_VIDEO_TABLES.online]: [{ record_id: "cleared", fields: { 视频上线地址: url } }],
      [STOREONE_VIDEO_TABLES.account]: [],
    });
    expect(inventory.pending).toHaveLength(1);
    expect(excludePreviouslyComplete(inventory.pending, {
      [`${STOREONE_VIDEO_TABLES.online}:7684496481503431949`]: "2026-09-14T00:00:00.000Z",
    })).toEqual([]);
  });

  it("uses only the selected store's table IDs for video business keys", () => {
    const sameVideo = "https://www.tiktok.com/@creator/video/7684496481503431949";
    const storetwo = buildStoreVideoInventory({
      [STORETWO_VIDEO_TABLES.online]: [{ record_id: "storetwo-1", fields: { 视频上线地址: sameVideo } }],
      [STORETWO_VIDEO_TABLES.account]: [],
      [STOREONE_VIDEO_TABLES.online]: [{ record_id: "storeone-1", fields: { 视频上线地址: sameVideo } }],
    }, STORETWO_VIDEO_TABLES);
    expect(storetwo.totalRows).toBe(1);
    expect(storetwo.pending.map((item) => item.key)).toEqual([
      `${STORETWO_VIDEO_TABLES.online}:7684496481503431949`,
    ]);
  });
});
