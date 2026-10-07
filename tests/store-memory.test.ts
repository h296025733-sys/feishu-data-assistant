import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoreMemoryService } from "../src/bot/store-memory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("店铺长期记忆", () => {
  it("只保存明确规则，并能按问题检索和纠正", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "store-memory-"));
    roots.push(root);
    const memory = new StoreMemoryService("shop-a", root);

    expect(await memory.handleMessage("今天天气不错", "u1")).toBeNull();
    const saved = await memory.handleMessage("记住：我们把电动磨脚器简称为磨脚器", "u1");
    expect(saved?.kind).toBe("saved");
    expect(await memory.relevantFacts("磨脚器最近销量怎么样")).toEqual([
      "我们把电动磨脚器简称为磨脚器",
    ]);

    const listed = await memory.handleMessage("你记住了什么", "u2");
    expect(listed?.text).toContain("电动磨脚器");
    const forgotten = await memory.handleMessage("忘记：电动磨脚器", "u2");
    expect(forgotten?.text).toContain("已移除 1 条");
    expect(await memory.list()).toHaveLength(0);
  });

  it("不同店铺物理隔离，文档要点只进入指定租户", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "store-memory-"));
    roots.push(root);
    const left = new StoreMemoryService("shop-a", root);
    const right = new StoreMemoryService("shop-b", root);
    await left.handleMessage("学习文档：本店默认按销售额判断商品表现", "u1");
    await left.learnDocument("规则.txt", "商品简称统一使用中文\nAPP_SECRET: should-not-save", "u1");
    expect(await left.list()).toHaveLength(2);
    expect(JSON.stringify(await left.list())).not.toContain("should-not-save");
    expect(await right.list()).toHaveLength(0);
  });
});
