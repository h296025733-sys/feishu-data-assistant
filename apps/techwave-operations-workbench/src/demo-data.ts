import { PRODUCT_METRICS, SHOP_METRICS, SHOP_NAME, dateKeyToTimestamp, type FieldName, type NormalizedRecord } from "./domain";

const products = ["电动磨脚器", "尾插充电宝", "无线迷你榨汁杯"];
const dates = Array.from({ length: 42 }, (_, index) => {
  const base = dateKeyToTimestamp("2026-06-22") + index * 86_400_000;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(base);
});

function productValues(productIndex: number, dateIndex: number): Partial<Record<FieldName, number | string | null>> {
  const active = (dateIndex + productIndex * 2) % 5 !== 0;
  const orders = active ? (dateIndex * 3 + productIndex * 5) % 17 : 0;
  const items = orders + (dateIndex % 3);
  const cardOrders = Math.min(orders, (dateIndex + productIndex) % 8);
  const cardItems = Math.min(items, cardOrders + (dateIndex % 2));
  const creatorOrders = orders - cardOrders;
  const creatorItems = items - cardItems;
  const allianceVideoOrders = Math.floor(creatorOrders * 0.45);
  const allianceLiveOrders = Math.floor(creatorOrders * 0.2);
  const selfVideoOrders = Math.floor(creatorOrders * 0.25);
  const selfLiveOrders = creatorOrders - allianceVideoOrders - allianceLiveOrders - selfVideoOrders;
  const allianceVideoItems = Math.floor(creatorItems * 0.45);
  const allianceLiveItems = Math.floor(creatorItems * 0.2);
  const selfVideoItems = Math.floor(creatorItems * 0.25);
  const selfLiveItems = creatorItems - allianceVideoItems - allianceLiveItems - selfVideoItems;
  const blankDay = dateIndex === 38 && productIndex === 1;
  return {
    合作量: (dateIndex + productIndex) % 4,
    上线量: (dateIndex + productIndex * 2) % 3,
    单量: blankDay ? null : orders,
    数量: blankDay ? null : items,
    达人出单量: blankDay ? null : orders - cardOrders,
    达人出单数量: blankDay ? null : items - cardItems,
    联盟达人视频出单量: blankDay ? null : allianceVideoOrders,
    联盟达人视频出单数量: blankDay ? null : allianceVideoItems,
    联盟达人直播出单量: blankDay ? null : allianceLiveOrders,
    联盟达人直播出单数量: blankDay ? null : allianceLiveItems,
    自营达人视频出单量: blankDay ? null : selfVideoOrders,
    自营达人视频出单数量: blankDay ? null : selfVideoItems,
    自营达人直播出单量: blankDay ? null : selfLiveOrders,
    自营达人直播出单数量: blankDay ? null : selfLiveItems,
    商品卡出单量: blankDay ? null : cardOrders,
    商品卡出单数量: blankDay ? null : cardItems,
    销售额: blankDay ? null : Number((orders * (12.8 + productIndex * 5.4)).toFixed(2)),
    出单视频: dateIndex % 7 === 0 ? 1 : null,
    自孵化出单量: null,
    自孵化上线量: null,
  };
}

function shopValues(dateIndex: number, productRows: NormalizedRecord[]): Partial<Record<FieldName, number | string | null>> {
  const sum = (name: FieldName) => productRows.reduce((total, row) => total + (typeof row.values[name] === "number" ? row.values[name] as number : 0), 0);
  const totalOrders = sum("单量");
  const visits = 85 + (dateIndex * 37) % 320;
  const advertisingSpend = dateIndex % 3 === 0 ? 12.5 + dateIndex : 0;
  const advertisingOrders = Math.floor(advertisingSpend / 6);
  return {
    合作量: sum("合作量"),
    上线量: sum("上线量"),
    店铺浏览量: dateIndex === 39 ? null : visits,
    总单量: totalOrders,
    总数量: sum("数量"),
    转化率: visits ? totalOrders / visits : null,
    达人出单量: sum("达人出单量"),
    店铺联盟达人视频出单量: sum("联盟达人视频出单量"),
    店铺联盟达人视频出单数量: sum("联盟达人视频出单数量"),
    店铺联盟达人直播出单量: sum("联盟达人直播出单量"),
    店铺联盟达人直播出单数量: sum("联盟达人直播出单数量"),
    店铺自营达人视频出单量: sum("自营达人视频出单量"),
    店铺自营达人视频出单数量: sum("自营达人视频出单数量"),
    店铺自营达人直播出单量: sum("自营达人直播出单量"),
    店铺自营达人直播出单数量: sum("自营达人直播出单数量"),
    店铺商品卡出单量: sum("商品卡出单量"),
    "店铺商品卡出单量(API)": sum("商品卡出单量"),
    店铺商品卡出单数量: sum("商品卡出单数量"),
    店铺销售额: sum("销售额"),
    出单视频: dateIndex % 6,
    广告花费: advertisingSpend,
    广告出单量: advertisingOrders,
    总广告花费: advertisingSpend,
    总广告出单量: advertisingOrders,
    退货量: dateIndex % 9 === 0 ? 2 : 0,
  };
}

export function createDemoRecords(): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];
  dates.forEach((dateKey, dateIndex) => {
    const productRows = products.map((product, productIndex): NormalizedRecord => ({
      recordId: `demo-product-${productIndex}-${dateIndex}`,
      product,
      dateKey,
      timestamp: dateKeyToTimestamp(dateKey),
      status: dateIndex === 38 && productIndex === 1 ? "待补数据" : "✓",
      values: productValues(productIndex, dateIndex),
    }));
    records.push(...productRows);
    records.push({
      recordId: `demo-shop-${dateIndex}`,
      product: SHOP_NAME,
      dateKey,
      timestamp: dateKeyToTimestamp(dateKey),
      status: dateIndex === 39 ? "待补数据" : "✓",
      values: shopValues(dateIndex, productRows),
    });
  });
  // 明确标记的演示异常：只用于视觉 QA。
  records.push({
    ...records.find((record) => record.product === products[2] && record.dateKey === "2026-07-14")!,
    recordId: "demo-duplicate",
    status: "⚠ 重复",
  });
  void PRODUCT_METRICS;
  void SHOP_METRICS;
  return records;
}
