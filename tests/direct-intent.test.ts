import { describe, expect, it } from "vitest";
import {
  isAutomaticSyncResultRequest,
  isBusinessBaseLinkRequest,
  isLatestBusinessDataRequest,
  isScheduleExpectationRequest,
  isTaskStatusRequest,
  parseStoreInitializationCommand,
} from "../src/bot/direct-intent.js";

describe("direct bot intents", () => {
  it("returns the current business Base for natural link requests", () => {
    expect(isBusinessBaseLinkRequest("多维表格链接发给我看看")).toBe(true);
    expect(isBusinessBaseLinkRequest("我要看看多维表格链接")).toBe(true);
    expect(isBusinessBaseLinkRequest("把 Base 地址给我")).toBe(true);
    expect(isBusinessBaseLinkRequest("这个达人有哪些视频链接")).toBe(false);
  });

  it("understands flexible recent-day initialization ranges", () => {
    expect(parseStoreInitializationCommand("初始化店铺")).toEqual({ days: null, force: false });
    expect(parseStoreInitializationCommand("补齐最近7天")).toEqual({ days: 7, force: true });
    expect(parseStoreInitializationCommand("把近十五天数据补全")).toEqual({ days: 15, force: true });
    expect(parseStoreInitializationCommand("同步最近三十一天")).toEqual({ days: 31, force: true });
    expect(parseStoreInitializationCommand("补齐近一个月数据")).toEqual({ days: 30, force: true });
    expect(parseStoreInitializationCommand("初始化店铺继续")).toEqual({ days: null, force: true, resume: true });
    expect(parseStoreInitializationCommand("继续补齐")).toEqual({ days: null, force: true, resume: true });
  });

  it("does not reinterpret a read-only date question as initialization", () => {
    expect(parseStoreInitializationCommand("最近30天哪个商品销量最好")).toBeNull();
  });

  it("understands natural questions about the current background task", () => {
    expect(isTaskStatusRequest("任务状态")).toBe(true);
    expect(isTaskStatusRequest("你现在在执行什么任务？")).toBe(true);
    expect(isTaskStatusRequest("刚刚的任务状态怎么样？")).toBe(true);
    expect(isTaskStatusRequest("刚才补齐到哪了")).toBe(true);
    expect(isTaskStatusRequest("这个同步还在跑吗")).toBe(true);
    expect(isTaskStatusRequest("最近30天哪个商品销量最好")).toBe(false);
  });

  it("recognizes natural questions about next update time and business date", () => {
    expect(isScheduleExpectationRequest("你今天几点能更新数据？更新的日期会是几号的数据（北京时间）")).toBe(true);
    expect(isScheduleExpectationRequest("下次什么时候同步")).toBe(true);
    expect(isScheduleExpectationRequest("你还有多少分钟更新今天的数据呢？北京时间的")).toBe(true);
    expect(isScheduleExpectationRequest("最近30天哪个商品销量最好")).toBe(false);
  });

  it("separates scheduled-sync results from historical backfill status", () => {
    expect(isAutomaticSyncResultRequest("你今天十点更新了什么数据")).toBe(true);
    expect(isAutomaticSyncResultRequest("你上次自动更新成功了吗？")).toBe(true);
    expect(isAutomaticSyncResultRequest("自动同步状态")).toBe(true);
    expect(isAutomaticSyncResultRequest("任务状态")).toBe(false);
  });

  it("treats asking to see latest data as a read-only business query", () => {
    expect(isLatestBusinessDataRequest("你最新更新的数据发给我")).toBe(true);
    expect(isLatestBusinessDataRequest("把刚同步的经营结果给我看看")).toBe(true);
    expect(isLatestBusinessDataRequest("把最新数据写入多维表")).toBe(false);
  });
});
