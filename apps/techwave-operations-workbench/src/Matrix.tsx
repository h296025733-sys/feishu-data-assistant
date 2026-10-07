import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  PRODUCT_METRICS,
  buildShopMetrics,
  formatMetricValue,
  getFormulaIssues,
  getRecord,
  getWeekInfo,
  hasAnomaly,
  indexRecords,
  isMetricManuallyEditable,
  needsManualInput,
  recordKey,
  type AdvertisingAccount,
  type MetricDefinition,
  type NormalizedDataset,
  type NormalizedRecord,
} from "./domain";
import type { CellWriteResult, ProductMapping, SaveState } from "./data-source";
import { productUrlForName } from "./product-links";

const PRODUCT_WIDTH = 154;
const METRIC_WIDTH = 252;
const TOTAL_WIDTH = 108;
const MONTH_TOTAL_WIDTH = 116;
const DATE_WIDTH = 84;
const STICKY_WIDTH = PRODUCT_WIDTH + METRIC_WIDTH + TOTAL_WIDTH;
const HEADER_HEIGHT = 104;
const ROW_HEIGHT = 56;
const SECTION_HEIGHT = 44;

export const PRODUCT_HEADER_LAYOUT = {
  collapse: { minWidth: 0, overflow: "hidden" },
  name: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  remove: { flex: "0 0 25px", width: 25, marginLeft: "auto" },
} as const;

export function hierarchyToneClass(group: string): string {
  if (group === "\u8054\u76df\u8fbe\u4eba\u51fa\u5355") return "tone-alliance";
  if (group === "\u81ea\u8425\u8fbe\u4eba\u51fa\u5355") return "tone-self";
  if (group === "\u5546\u54c1\u5361\u51fa\u5355") return "tone-product-card";
  return "";
}

export function hierarchyGridClass(hierarchy: NonNullable<MetricDefinition["hierarchy"]>): string {
  return hierarchy.channel ? "" : "hierarchy-channel-less";
}

type MatrixRow =
  | { id: string; kind: "section"; product: string; section: "shop" | "product"; metricCount: number }
  | {
      id: string;
      kind: "metric";
      product: string;
      section: "shop" | "product";
      metric: MetricDefinition;
       metricIndex: number;
       groupStart: boolean;
       groupEnd: boolean;
       channelStart: boolean;
       channelEnd: boolean;
      showGroupLabel: boolean;
      showChannelLabel: boolean;
      groupRowSpan: number;
      channelRowSpan: number;
      advertisingStart: boolean;
      advertisingEnd: boolean;
      showAdvertisingAccount: boolean;
      advertisingRowSpan: number;
     };

interface MatrixProps {
  records: NormalizedRecord[];
  fieldsByName: NormalizedDataset["fieldsByName"];
  dates: string[];
  query: string;
  onlyAnomalies: boolean;
  onlyMissing: boolean;
  editable: boolean;
  allowEnsureRecords: boolean;
  canDeleteProducts: boolean;
  advertisingAccounts: AdvertisingAccount[];
  productMappings: ProductMapping[];
  aggregateLabel: string;
  dimensionLabel: "产品" | "账号";
  aggregateMetrics: MetricDefinition[];
  dimensionMetrics: MetricDefinition[];
  showProductLinks: boolean;
  validateStoreFormulas: boolean;
  onSave: (request: { recordId: string; fieldName: string; expectedValue: number | null; nextValue: number | null }) => Promise<CellWriteResult>;
  onSaved: (recordId: string, fieldName: string, value: number | null) => void;
  onEnsureRecord: (product: string, dateKey: string) => Promise<void>;
  onDeleteProduct: (product: string) => void;
  onMessage: (message: string, tone: "success" | "warning" | "error") => void;
}

type MatrixColumn =
  | { kind: "monthTotal"; key: string; monthKey: string }
  | { kind: "date"; key: string; dateKey: string };

interface MatrixColumnLayout {
  column: MatrixColumn;
  start: number;
  size: number;
}

export function buildMatrixColumns(dates: string[]): MatrixColumn[] {
  const columns: MatrixColumn[] = [];
  let previousMonth = "";
  for (const dateKey of dates) {
    const monthKey = dateKey.slice(0, 7);
    if (monthKey !== previousMonth) {
      columns.push({ kind: "monthTotal", key: `month:${monthKey}`, monthKey });
      previousMonth = monthKey;
    }
    columns.push({ kind: "date", key: `date:${dateKey}`, dateKey });
  }
  return columns;
}

function buildLayouts(columns: MatrixColumn[]): MatrixColumnLayout[] {
  let start = 0;
  return columns.map((column) => {
    const size = column.kind === "monthTotal" ? MONTH_TOTAL_WIDTH : DATE_WIDTH;
    const layout = { column, start, size };
    start += size;
    return layout;
  });
}

export function stickyMonthLeft(
  currentStart: number,
  currentSize: number,
  nextMonthStart: number | undefined,
  scrollLeft: number,
): number {
  const original = STICKY_WIDTH + currentStart;
  const desired = Math.max(original, scrollLeft + STICKY_WIDTH);
  if (nextMonthStart === undefined) return desired;
  return Math.min(desired, STICKY_WIDTH + nextMonthStart - currentSize);
}

export function stickyMonthOffset(
  currentStart: number,
  currentSize: number,
  nextMonthStart: number | undefined,
  scrollLeft: number,
): number {
  return stickyMonthLeft(currentStart, currentSize, nextMonthStart, scrollLeft) - (STICKY_WIDTH + currentStart);
}

interface HierarchyLayout {
  groupStart: boolean;
  groupEnd: boolean;
  channelStart: boolean;
  channelEnd: boolean;
  showGroupLabel: boolean;
  showChannelLabel: boolean;
  groupRowSpan: number;
  channelRowSpan: number;
}

interface AdvertisingLayout {
  advertisingStart: boolean;
  advertisingEnd: boolean;
  showAdvertisingAccount: boolean;
  advertisingRowSpan: number;
}

export function hierarchyLayoutForMetric(metrics: MetricDefinition[], indexValue: number): HierarchyLayout {
  const current = metrics[indexValue]?.hierarchy;
  if (!current) {
    return {
      groupStart: true,
      groupEnd: true,
      channelStart: true,
      channelEnd: true,
      showGroupLabel: false,
      showChannelLabel: false,
      groupRowSpan: 0,
      channelRowSpan: 0,
    };
  }
  let groupStartIndex = indexValue;
  let groupEndIndex = indexValue;
  while (metrics[groupStartIndex - 1]?.hierarchy?.group === current.group) groupStartIndex -= 1;
  while (metrics[groupEndIndex + 1]?.hierarchy?.group === current.group) groupEndIndex += 1;

  let channelStartIndex = indexValue;
  let channelEndIndex = indexValue;
  while (
    metrics[channelStartIndex - 1]?.hierarchy?.group === current.group
    && metrics[channelStartIndex - 1]?.hierarchy?.channel === current.channel
  ) channelStartIndex -= 1;
  while (
    metrics[channelEndIndex + 1]?.hierarchy?.group === current.group
    && metrics[channelEndIndex + 1]?.hierarchy?.channel === current.channel
  ) channelEndIndex += 1;

  return {
    groupStart: indexValue === groupStartIndex,
    groupEnd: indexValue === groupEndIndex,
    channelStart: indexValue === channelStartIndex,
    channelEnd: indexValue === channelEndIndex,
    showGroupLabel: indexValue === groupStartIndex,
    showChannelLabel: indexValue === channelStartIndex,
    groupRowSpan: indexValue === groupStartIndex ? groupEndIndex - groupStartIndex + 1 : 0,
    channelRowSpan: indexValue === channelStartIndex ? channelEndIndex - channelStartIndex + 1 : 0,
  };
}

export function advertisingLayoutForMetric(metrics: MetricDefinition[], indexValue: number): AdvertisingLayout {
  const current = metrics[indexValue]?.advertising;
  if (current?.kind === "summary") {
    let start = indexValue;
    let end = indexValue;
    while (metrics[start - 1]?.advertising?.kind === "summary") start -= 1;
    while (metrics[end + 1]?.advertising?.kind === "summary") end += 1;
    return {
      advertisingStart: indexValue === start,
      advertisingEnd: indexValue === end,
      showAdvertisingAccount: false,
      advertisingRowSpan: 0,
    };
  }
  if (current?.kind !== "account" || !current.accountId) {
    return { advertisingStart: true, advertisingEnd: true, showAdvertisingAccount: false, advertisingRowSpan: 0 };
  }
  let start = indexValue;
  let end = indexValue;
  while (metrics[start - 1]?.advertising?.accountId === current.accountId) start -= 1;
  while (metrics[end + 1]?.advertising?.accountId === current.accountId) end += 1;
  return {
    advertisingStart: indexValue === start,
    advertisingEnd: indexValue === end,
    showAdvertisingAccount: indexValue === start,
    advertisingRowSpan: indexValue === start ? end - start + 1 : 0,
  };
}

export function metricPresentationClass(metric: MetricDefinition, displayName = metric.name): string {
  if (metric.hierarchy) return "metric-presentation-hierarchy";
  if (metric.source === "manual") return "metric-presentation-manual";
  if (["合作量", "上线量", "店铺浏览量", "出单视频"].includes(displayName)) return "metric-presentation-activity";
  if (metric.format === "money" || ["单量", "数量", "总单量", "总数量", "转化率"].includes(displayName)) {
    return `metric-presentation-kpi${metric.format === "money" ? " metric-presentation-money" : ""}`;
  }
  return "metric-presentation-support";
}

export function shouldOfferMissingRecordAction(
  section: "shop" | "product",
  metric: MetricDefinition,
): boolean {
  void section;
  return isMetricManuallyEditable(metric);
}

export function compactAdvertisingAccount(account: string): string {
  const match = account.trim().match(/^(MAX)[-\s]+(.+?)-(\d+-\d+)$/i);
  if (!match) return account.trim();
  const company = match[2]
    .replace(/\b(?:COMPANY|LIMITED|LTD|CO)\b/gi, " ")
    .replace(/[-\s]+/g, " ")
    .trim();
  return `${company || match[2]} · ${match[3]}`;
}

type AggregateIndex = Map<string, number>;

function aggregateIndexKey(product: string, fieldName: string, monthKey = "*"): string {
  return `${product}\u0000${fieldName}\u0000${monthKey}`;
}

export function buildMetricAggregateIndex(
  records: NormalizedRecord[],
  metrics: MetricDefinition[] = [...buildShopMetrics([]), ...PRODUCT_METRICS],
): AggregateIndex {
  const fieldAggregations = new Map<string, "sum" | "average">();
  for (const metric of metrics) {
    if (metric.aggregate === false) continue;
    const aggregation = metric.aggregation ?? "sum";
    const existing = fieldAggregations.get(metric.fieldName);
    if (existing && existing !== aggregation) {
      throw new Error(`字段 ${metric.fieldName} 存在冲突的聚合方式`);
    }
    fieldAggregations.set(metric.fieldName, aggregation);
  }

  const accumulators = new Map<string, { sum: number; count: number; aggregation: "sum" | "average" }>();
  for (const record of records) {
    for (const [fieldName, aggregation] of fieldAggregations) {
      const value = record.values[fieldName];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const monthKey = record.dateKey.slice(0, 7);
      const allKey = aggregateIndexKey(record.product, fieldName);
      const monthIndexKey = aggregateIndexKey(record.product, fieldName, monthKey);
      for (const key of [allKey, monthIndexKey]) {
        const current = accumulators.get(key);
        if (current) {
          current.sum += value;
          current.count += 1;
        } else {
          accumulators.set(key, { sum: value, count: 1, aggregation });
        }
      }
    }
  }

  const result: AggregateIndex = new Map();
  for (const [key, accumulator] of accumulators) {
    result.set(key, accumulator.aggregation === "average" ? accumulator.sum / accumulator.count : accumulator.sum);
  }
  return result;
}

export function readMetricAggregate(
  index: AggregateIndex,
  product: string,
  metric: MetricDefinition,
  monthKey?: string,
): number | null {
  if (metric.aggregate === false) return null;
  const key = aggregateIndexKey(product, metric.fieldName, monthKey);
  return index.has(key) ? index.get(key)! : null;
}

function buildGroups(layouts: MatrixColumnLayout[], key: (date: string) => string, label: (date: string) => string) {
  const groups: { key: string; label: string; start: number; width: number; end: number }[] = [];
  layouts.filter((layout) => layout.column.kind === "date").forEach((layout) => {
    const date = (layout.column as Extract<MatrixColumn, { kind: "date" }>).dateKey;
    const groupKey = key(date);
    const last = groups.at(-1);
    if (last?.key === groupKey && last.end === layout.start) {
      last.width += layout.size;
      last.end += layout.size;
    } else {
      groups.push({ key: groupKey, label: label(date), start: layout.start, width: layout.size, end: layout.start + layout.size });
    }
  });
  return groups;
}

function parseInput(raw: string, metric: MetricDefinition): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return { ok: false, message: "请输入普通数字，不使用逗号、单位或科学计数法" };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, message: "数字超出可保存范围" };
  if (value < 0) return { ok: false, message: "经营录入值不能为负数；如需纠错请修改原始来源" };
  if (metric.format === "count" && !Number.isInteger(value)) return { ok: false, message: "该指标按数量统计，请输入整数" };
  return { ok: true, value };
}

function EditableCell({
  record,
  metric,
  disabled,
  onSave,
  onSaved,
  onMessage,
}: {
  record: NormalizedRecord;
  metric: MetricDefinition;
  disabled: boolean;
  onSave: MatrixProps["onSave"];
  onSaved: MatrixProps["onSaved"];
  onMessage: MatrixProps["onMessage"];
}) {
  const current = typeof record.values[metric.fieldName] === "number" ? record.values[metric.fieldName] as number : null;
  const [raw, setRaw] = useState(current === null ? "" : String(current));
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<number>();
  const expected = useRef<number | null>(current);

  useEffect(() => {
    if (state !== "saving") {
      setRaw(current === null ? "" : String(current));
      expected.current = current;
    }
  }, [current, state]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const commit = async (nextRaw = raw) => {
    window.clearTimeout(timer.current);
    const parsed = parseInput(nextRaw, metric);
    if (!parsed.ok) {
      setState("error");
      onMessage(parsed.message, "error");
      return;
    }
    if (parsed.value === expected.current) {
      setState("idle");
      return;
    }
    setState("saving");
    const result = await onSave({
      recordId: record.recordId,
      fieldName: metric.fieldName,
      expectedValue: expected.current,
      nextValue: parsed.value,
    });
    setState(result.state);
    setRaw(result.value === null ? "" : String(result.value));
    expected.current = result.value;
    if (result.state === "saved") onSaved(record.recordId, metric.fieldName, result.value);
    onMessage(result.message, result.state === "saved" ? "success" : result.state === "conflict" ? "warning" : "error");
  };

  return (
    <label className={`editable-cell source-${metric.source} save-${state}`} title={metric.description}>
      <input
        aria-label={`${record.product} ${record.dateKey} ${metric.name}`}
        disabled={disabled || state === "saving"}
        inputMode={metric.format === "count" ? "numeric" : "decimal"}
        value={raw}
        onFocus={() => onMessage(metric.description, "success")}
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          setState("idle");
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void commit(next), 650);
        }}
        onBlur={(event) => void commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit(event.currentTarget.value);
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            window.clearTimeout(timer.current);
            setRaw(expected.current === null ? "" : String(expected.current));
            setState("idle");
            event.currentTarget.blur();
          }
        }}
      />
      <span className="save-indicator" aria-label={state}>
        {state === "saving" ? "…" : state === "saved" ? "✓" : state === "conflict" ? "!" : state === "error" ? "×" : ""}
      </span>
    </label>
  );
}

export function Matrix(props: MatrixProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stickyFrameRef = useRef<number>();
  const pendingScrollLeftRef = useRef(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const index = useMemo(() => indexRecords(props.records), [props.records]);
  const dateSet = useMemo(() => new Set(props.dates), [props.dates]);
  const dateInfoByKey = useMemo(() => new Map(props.dates.map((dateKey) => [dateKey, getWeekInfo(dateKey)])), [props.dates]);
  const shopMetrics = useMemo(
    () => props.validateStoreFormulas ? buildShopMetrics(props.advertisingAccounts) : props.aggregateMetrics,
    [props.advertisingAccounts, props.aggregateMetrics, props.validateStoreFormulas],
  );
  const aggregateIndex = useMemo(
    () => buildMetricAggregateIndex(props.records, [...shopMetrics, ...props.dimensionMetrics]),
    [props.dimensionMetrics, props.records, shopMetrics],
  );
  const formulaIssuesByRecord = useMemo(() => new Map(
    props.records.map((record) => [record.recordId, props.validateStoreFormulas ? getFormulaIssues(props.records, record) : []]),
  ), [props.records, props.validateStoreFormulas]);

  const visibleProducts = useMemo(() => index.products.filter((product) => {
    if (props.query && !product.toLocaleLowerCase("zh-CN").includes(props.query.toLocaleLowerCase("zh-CN"))) return false;
    const productRecords = props.records.filter((record) => record.product === product && dateSet.has(record.dateKey));
    if (props.onlyAnomalies && !productRecords.some((record) => hasAnomaly(record, index.duplicateKeys.has(recordKey(product, record.dateKey))) || (formulaIssuesByRecord.get(record.recordId)?.length ?? 0) > 0)) return false;
    if (props.onlyMissing && !productRecords.some((record) => needsManualInput(record, product))) return false;
    return true;
  }), [dateSet, formulaIssuesByRecord, index.duplicateKeys, index.products, props.onlyAnomalies, props.onlyMissing, props.query, props.records]);

  const rows = useMemo(() => {
    const result: MatrixRow[] = [];
    const addSection = (product: string, section: "shop" | "product", metrics: MetricDefinition[]) => {
      const visibleMetrics = metrics.filter((metric) => metric.visible !== false);
      result.push({ id: `section:${product}`, kind: "section", product, section, metricCount: visibleMetrics.length });
      if (!collapsed.has(product)) visibleMetrics.forEach((metric, metricIndex) => {
        const hierarchyLayout = hierarchyLayoutForMetric(visibleMetrics, metricIndex);
        const advertisingLayout = advertisingLayoutForMetric(visibleMetrics, metricIndex);
        result.push({
          id: `${product}:${metric.fieldName}`,
          kind: "metric",
          product,
          section,
          metric,
          metricIndex,
          ...hierarchyLayout,
          ...advertisingLayout,
        });
      });
    };
    if (props.records.some((record) => record.product === props.aggregateLabel)) {
      addSection(props.aggregateLabel, "shop", shopMetrics);
    }
    visibleProducts.forEach((product) => addSection(product, "product", props.dimensionMetrics));
    return result;
  }, [collapsed, props.aggregateLabel, props.dimensionMetrics, props.records, shopMetrics, visibleProducts]);

  const columns = useMemo(() => buildMatrixColumns(props.dates), [props.dates]);
  const columnLayouts = useMemo(() => buildLayouts(columns), [columns]);
  const monthTotalLayouts = useMemo(() => columnLayouts.filter((layout) => layout.column.kind === "monthTotal"), [columnLayouts]);

  const updateStickyMonthOffsets = useCallback((scrollLeft: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    monthTotalLayouts.forEach((layout, monthIndex) => {
      const offset = stickyMonthOffset(layout.start, layout.size, monthTotalLayouts[monthIndex + 1]?.start, scrollLeft);
      canvas.style.setProperty(`--sticky-month-${monthIndex}`, `${offset}px`);
    });
  }, [monthTotalLayouts]);

  const handleMatrixScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    pendingScrollLeftRef.current = event.currentTarget.scrollLeft;
    if (stickyFrameRef.current !== undefined) return;
    stickyFrameRef.current = window.requestAnimationFrame(() => {
      stickyFrameRef.current = undefined;
      updateStickyMonthOffsets(pendingScrollLeftRef.current);
    });
  }, [updateStickyMonthOffsets]);

  useEffect(() => {
    updateStickyMonthOffsets(scrollRef.current?.scrollLeft ?? 0);
    return () => {
      if (stickyFrameRef.current !== undefined) window.cancelAnimationFrame(stickyFrameRef.current);
    };
  }, [updateStickyMonthOffsets]);

  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (indexValue) => columns[indexValue]?.kind === "monthTotal" ? MONTH_TOTAL_WIDTH : DATE_WIDTH,
    overscan: 4,
  });
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (indexValue) => rows[indexValue]?.kind === "section" ? SECTION_HEIGHT : ROW_HEIGHT,
    overscan: 10,
  });

  const months = useMemo(() => buildGroups(columnLayouts, (date) => date.slice(0, 7), (date) => `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月`), [columnLayouts]);
  const weeks = useMemo(() => buildGroups(
    columnLayouts,
    (date) => dateInfoByKey.get(date)!.key,
    (date) => dateInfoByKey.get(date)!.label,
  ), [columnLayouts, dateInfoByKey]);
  const sectionStatsByProduct = useMemo(() => {
    const stats = new Map<string, { issueCount: number; pendingCount: number }>();
    for (const record of props.records) {
      if (!dateSet.has(record.dateKey)) continue;
      const current = stats.get(record.product) ?? { issueCount: 0, pendingCount: 0 };
      if (
        hasAnomaly(record, index.duplicateKeys.has(recordKey(record.product, record.dateKey)))
        || (formulaIssuesByRecord.get(record.recordId)?.length ?? 0) > 0
      ) current.issueCount += 1;
      if (needsManualInput(record, record.product)) current.pendingCount += 1;
      stats.set(record.product, current);
    }
    return stats;
  }, [dateSet, formulaIssuesByRecord, index.duplicateKeys, props.records]);
  const totalCanvasWidth = STICKY_WIDTH + columnVirtualizer.getTotalSize();
  const totalCanvasHeight = HEADER_HEIGHT + rowVirtualizer.getTotalSize();
  const displayMetricName = (metric: MetricDefinition) => props.fieldsByName.get(metric.fieldName)?.name ?? metric.name;
  const productUrls = useMemo(() => new Map(
    visibleProducts.map((product) => [product, productUrlForName(product, props.productMappings)]),
  ), [props.productMappings, visibleProducts]);

  const renderStickyHeader = () => (
    <div className="sticky-header-group" style={{ width: STICKY_WIDTH }}>
      <div className="head-sticky product-head" style={{ width: PRODUCT_WIDTH }}>{props.dimensionLabel}</div>
      <div className="head-sticky metric-head" style={{ width: METRIC_WIDTH }}>指标</div>
      <div className="head-sticky total-head" style={{ width: TOTAL_WIDTH }}>合计全部</div>
    </div>
  );

  return (
    <div className="matrix-shell">
      <div ref={scrollRef} className="matrix-scroll" data-testid="matrix-scroll" onScroll={handleMatrixScroll}>
        <div ref={canvasRef} className="matrix-canvas" style={{ width: totalCanvasWidth, height: totalCanvasHeight }}>
          <div className="matrix-header" style={{ width: totalCanvasWidth }}>
            {renderStickyHeader()}
            <div className="date-header-layer month-layer">
              {months.map((group) => (
                <div key={group.key} className="date-group month-group" style={{ left: STICKY_WIDTH + group.start, width: group.width }}>{group.label}</div>
              ))}
            </div>
            <div className="date-header-layer week-layer">
              {weeks.map((group) => (
                <div key={`${group.key}:${group.start}`} className="date-group week-group" style={{ left: STICKY_WIDTH + group.start, width: group.width }}>周 · {group.label}</div>
              ))}
            </div>
            {monthTotalLayouts.map((layout, monthIndex) => {
              const monthKey = (layout.column as Extract<MatrixColumn, { kind: "monthTotal" }>).monthKey;
              const style: CSSProperties = {
                left: STICKY_WIDTH + layout.start,
                width: layout.size,
                transform: `translate3d(var(--sticky-month-${monthIndex}, 0px), 0, 0)`,
              };
              return (
                <div key={layout.column.key} className="month-total-header" style={style}>
                  <span>合计</span><strong>{monthKey.slice(0, 4)}年{Number(monthKey.slice(5))}月</strong>
                </div>
              );
            })}
            <div className="date-header-layer date-layer">
              {columnVirtualizer.getVirtualItems().map((column) => {
                const definition = columns[column.index];
                if (definition.kind !== "date") return null;
                return <div key={definition.key} className="date-head" style={{ left: STICKY_WIDTH + column.start, width: column.size }}>{definition.dateKey.slice(5).replace("-", "/")}</div>;
              })}
            </div>
            <div className="date-header-layer weekday-layer">
              {columnVirtualizer.getVirtualItems().map((column) => {
                const definition = columns[column.index];
                if (definition.kind !== "date") return null;
                const info = dateInfoByKey.get(definition.dateKey)!;
                return <div key={definition.key} className={`weekday-head ${info.weekend ? "weekend" : ""}`} style={{ left: STICKY_WIDTH + column.start, width: column.size }}>{info.weekday}</div>;
              })}
            </div>
          </div>

          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            const top = HEADER_HEIGHT + virtualRow.start;
            if (row.kind === "section") {
              const { issueCount, pendingCount } = sectionStatsByProduct.get(row.product) ?? { issueCount: 0, pendingCount: 0 };
              return (
                <div key={row.id} className={`matrix-row section-row section-${row.section}`} style={{ top, height: virtualRow.size, width: totalCanvasWidth }}>
                  <div className="section-fill" style={{ left: STICKY_WIDTH, width: totalCanvasWidth - STICKY_WIDTH }} />
                  <div className="sticky-cell section-product" style={{ left: 0, width: PRODUCT_WIDTH }}>
                    <button type="button" className="collapse-button" style={PRODUCT_HEADER_LAYOUT.collapse} onClick={() => setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(row.product)) next.delete(row.product); else next.add(row.product);
                      return next;
                    })} aria-label={`${collapsed.has(row.product) ? "展开" : "收起"}${row.product}`}>
                      <span className="collapse-icon">{collapsed.has(row.product) ? "▸" : "▾"}</span>
                      <span className="product-name" style={PRODUCT_HEADER_LAYOUT.name} title={row.product}>{row.product}</span>
                    </button>
                    {row.section === "product" && props.canDeleteProducts && (
                      <button
                        type="button"
                        className="delete-product-button"
                        style={PRODUCT_HEADER_LAYOUT.remove}
                        title={`删除商品“${row.product}”`}
                        aria-label={`删除商品${row.product}`}
                        onClick={() => props.onDeleteProduct(row.product)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm3 2v7h2v-7H9Zm4 0v7h2v-7h-2Z" /></svg>
                      </button>
                    )}
                  </div>
                  <div className="sticky-cell section-summary" style={{ left: PRODUCT_WIDTH, width: METRIC_WIDTH }}>{row.section === "shop" ? (props.validateStoreFormulas ? "店铺经营总览" : "店铺账号经营总览") : `${row.metricCount} 项经营指标`}</div>
                  <div className="sticky-cell section-status" style={{ left: PRODUCT_WIDTH + METRIC_WIDTH, width: TOTAL_WIDTH }}>
                    {issueCount ? <span className="issue-pill">{issueCount} 条异常</span> : pendingCount ? <span className="pending-pill">{pendingCount} 条待补</span> : null}
                  </div>
                </div>
              );
            }

            const allValue = readMetricAggregate(aggregateIndex, row.product, row.metric);
            const metricName = displayMetricName(row.metric);
            const presentationClass = metricPresentationClass(row.metric, metricName);
            const hierarchyClasses = row.metric.hierarchy
              ? `hierarchy-row ${row.groupStart ? "hierarchy-group-start" : ""} ${row.groupEnd ? "hierarchy-group-end" : ""} ${row.channelStart ? "hierarchy-channel-start" : ""} ${row.channelEnd ? "hierarchy-channel-end" : ""}`
              : "";
            return (
              <div key={row.id} className={`matrix-row metric-row section-${row.section} ${hierarchyClasses} ${row.metric.advertising ? `advertising-row advertising-${row.metric.advertising.kind} ${row.advertisingStart ? "advertising-start" : ""} ${row.advertisingEnd ? "advertising-end" : ""}` : ""}`} style={{ top, height: virtualRow.size, width: totalCanvasWidth }}>
                <div className="sticky-cell product-spacer" style={{ left: 0, width: PRODUCT_WIDTH }}>
                  {props.showProductLinks && row.section === "product" && row.metricIndex === 0 && productUrls.get(row.product) && (
                    <a
                      className="product-direct-link"
                      href={productUrls.get(row.product)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`打开“${row.product}”的 TikTok 商品页`}
                      aria-label={`打开${row.product}TikTok商品页`}
                    >
                      <span>直达链接</span>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M9.25 2H14v4.75h-1.5V4.56L7.53 9.53 6.47 8.47l4.97-4.97H9.25V2ZM3.5 3.5h4V5h-4v7.5H11V8.75h1.5v3.75A1.5 1.5 0 0 1 11 14H3.5A1.5 1.5 0 0 1 2 12.5V5a1.5 1.5 0 0 1 1.5-1.5Z" />
                      </svg>
                    </a>
                  )}
                </div>
                <div className={`sticky-cell metric-cell ${row.metric.hierarchy ? "metric-cell-hierarchical" : ""} ${presentationClass}`} style={{ left: PRODUCT_WIDTH, width: METRIC_WIDTH }} title={`${metricName}：${row.metric.description}`}>
                  {row.metric.hierarchy ? (
                    <div className={`metric-hierarchy ${hierarchyToneClass(row.metric.hierarchy.group)} ${hierarchyGridClass(row.metric.hierarchy)}`} aria-label={`${row.metric.hierarchy.group} ${row.metric.hierarchy.channel ?? ""} ${row.metric.hierarchy.measure}`}>
                      <span className={`metric-level metric-group ${row.groupStart ? "level-start" : "level-continued"} ${row.groupEnd ? "level-end" : ""}`} />
                      {row.metric.hierarchy.channel && <span className={`metric-level metric-channel ${row.channelStart ? "level-start" : "level-continued"} ${row.channelEnd ? "level-end" : ""}`} />}
                      <strong className="metric-level metric-measure">{row.metric.hierarchy.measure}</strong>
                      {row.showGroupLabel && (
                        <span
                          className="metric-span-label metric-group-span-label"
                          style={{ height: ROW_HEIGHT * row.groupRowSpan }}
                        >
                          {row.metric.hierarchy.group}
                        </span>
                      )}
                      {row.metric.hierarchy.channel && row.showChannelLabel && (
                        <span
                          className="metric-span-label metric-channel-span-label"
                          style={{ height: ROW_HEIGHT * row.channelRowSpan }}
                        >
                          {row.metric.hierarchy.channel}
                        </span>
                      )}
                    </div>
                  ) : row.metric.advertising?.kind === "summary" ? (
                    <span className={`metric-advertising-summary summary-${row.metric.advertising.measure}`}>
                      <small>{row.metric.advertising.measure === "spend" ? "广告投放总览" : "全部账户合计"}</small>
                      <strong>{metricName}</strong>
                    </span>
                  ) : row.metric.advertising?.kind === "account" ? (
                    <span className="metric-advertising-account">
                      <span
                        className={`advertising-account-name ${row.showAdvertisingAccount ? "account-name-anchor" : "account-name-continued"}`}
                        style={row.showAdvertisingAccount ? { height: ROW_HEIGHT * row.advertisingRowSpan } : undefined}
                        title={row.metric.advertising.accountName}
                      >
                        {row.showAdvertisingAccount && (
                          <>
                            <span className="advertising-account-label">{compactAdvertisingAccount(row.metric.advertising.accountName ?? "")}</span>
                            <span className="advertising-manual-chip">人工</span>
                          </>
                        )}
                      </span>
                      <strong>{row.metric.advertising.measure === "spend" ? "广告花费" : "广告出单量"}</strong>
                    </span>
                  ) : <span className="metric-name">{metricName}</span>}
                  {row.metric.source === "manual" && !row.metric.advertising && <span className="source-badge source-manual">人工</span>}
                </div>
                <div className="sticky-cell aggregate-cell total-cell" style={{ left: PRODUCT_WIDTH + METRIC_WIDTH, width: TOTAL_WIDTH }}>
                  <span className="numeric-cell-value">{formatMetricValue(allValue, row.metric)}</span>
                </div>
                {monthTotalLayouts.map((layout, monthIndex) => {
                  const definition = layout.column as Extract<MatrixColumn, { kind: "monthTotal" }>;
                  const monthValue = readMetricAggregate(aggregateIndex, row.product, row.metric, definition.monthKey);
                  const style: CSSProperties = {
                    left: STICKY_WIDTH + layout.start,
                    width: layout.size,
                    transform: `translate3d(var(--sticky-month-${monthIndex}, 0px), 0, 0)`,
                  };
                  return (
                    <div key={definition.key} className="date-cell aggregate-cell month-total-cell" style={style}>
                      <span className="numeric-cell-value">{formatMetricValue(monthValue, row.metric)}</span>
                    </div>
                  );
                })}
                {columnVirtualizer.getVirtualItems().map((column) => {
                  const definition = columns[column.index];
                  if (definition.kind === "monthTotal") return null;
                  const dateKey = definition.dateKey;
                  const record = getRecord(index, row.product, dateKey);
                  const duplicate = index.duplicateKeys.has(recordKey(row.product, dateKey));
                  const formulaIssues = record ? formulaIssuesByRecord.get(record.recordId) ?? [] : [];
                  const anomalous = hasAnomaly(record, duplicate) || formulaIssues.length > 0;
                  const cellIssue = formulaIssues.find((item) => item.startsWith(row.metric.fieldName));
                  const value = record && typeof record.values[row.metric.fieldName] === "number" ? record.values[row.metric.fieldName] as number : null;
                  const showCreate = props.allowEnsureRecords && !record && shouldOfferMissingRecordAction(row.section, row.metric);
                  return (
                    <div
                      key={dateKey}
                      className={`date-cell source-${row.metric.source} ${dateInfoByKey.get(dateKey)?.weekend ? "weekend-column" : ""} ${anomalous ? "anomaly-cell" : ""} ${record && needsManualInput(record, row.product) && isMetricManuallyEditable(row.metric) && value === null ? "missing-cell" : ""}`}
                      style={{ left: STICKY_WIDTH + column.start, width: column.size }}
                      title={duplicate ? "同一商品和日期存在重复记录" : cellIssue || record?.status || row.metric.description}
                    >
                      {record ? (
                        isMetricManuallyEditable(row.metric) ? (
                          <EditableCell
                            record={record}
                            metric={row.metric}
                            disabled={!props.editable}
                            onSave={props.onSave}
                            onSaved={props.onSaved}
                            onMessage={props.onMessage}
                          />
                        ) : <span className="readonly-value">{formatMetricValue(value, row.metric)}</span>
                      ) : showCreate ? (
                        <button type="button" className="create-day-button" disabled={!props.editable} onClick={() => void props.onEnsureRecord(row.product, dateKey)}>
                          {row.section === "shop" ? "＋ 填写" : "＋ 新增"}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
