export const PRODUCT_ROI_COLUMNS = [
  "检查", "店铺", "商品", "TikTok商品ID", "日期", "上线量", "出单视频", "单量", "数量", "视频曝光", "销售额", "数据状态",
  "广告花费有", "广告花费", "广告出单量",
] as const;

export const ACCOUNT_ROI_COLUMNS = [
  "检查", "店铺", "账号", "账号UID", "日期", "上线量", "出单视频", "单量", "数量", "视频曝光", "销售额", "数据状态", "账号类型",
  "广告花费", "广告出单量",
] as const;

const STORE_ROI_COLUMNS_BEFORE_API_AD = [
  "检查", "商品", "日期", "月份", "周", "星期", "合作量", "上线量", "单量", "数量", "达人出单量", "达人出单数量",
  "商品卡出单量", "商品卡出单数量", "销售额", "出单视频", "自孵化出单量", "自孵化上线量", "店铺浏览量",
  "总单量", "总数量", "店铺商品卡出单量", "店铺销售额", "转化率", "总广告出单量", "总广告花费",
] as const;

const STORE_ROI_COLUMNS_AFTER_API_AD = [
  "退货量", "备注", "记录类型", "合作量源", "上线量源", "达人出单量源", "排序键",
  "联盟达人视频出单量", "联盟达人视频出单数量", "联盟达人直播出单量", "联盟达人直播出单数量",
  "自营达人视频出单量", "自营达人视频出单数量", "自营达人直播出单量", "自营达人直播出单数量",
  "店铺联盟达人视频出单量", "店铺联盟达人视频出单数量", "店铺联盟达人直播出单量", "店铺联盟达人直播出单数量",
  "店铺自营达人视频出单量", "店铺自营达人视频出单数量", "店铺自营达人直播出单量", "店铺自营达人直播出单数量",
  "店铺商品卡出单量(API)", "店铺商品卡出单数量",
] as const;

export function storeRoiColumns(advertising?: {
  spendFieldName: string;
  orderFieldName: string;
}): string[] {
  const apiAdvertisingColumns = advertising
    ? [advertising.spendFieldName, advertising.orderFieldName]
    : [];
  return [
    ...STORE_ROI_COLUMNS_BEFORE_API_AD,
    ...apiAdvertisingColumns,
    ...STORE_ROI_COLUMNS_AFTER_API_AD,
  ];
}

export function toBrowserTsv(
  columns: readonly string[],
  rows: Array<Record<string, string | number>>,
): string {
  return rows.map((row) => columns.map((column) => tsvCell(row[column])).join("\t")).join("\r\n");
}

function tsvCell(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).replace(/[\t\r\n]+/g, " ");
}
