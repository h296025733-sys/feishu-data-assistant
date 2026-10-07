import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Matrix } from "./Matrix";
import { createDemoRecords } from "./demo-data";
import {
  currentShanghaiDateKey,
  enumerateDateKeys,
  getLatestMonth,
  monthBounds,
  rollingDateBounds,
  type AdvertisingAccount,
  type FieldName,
  type NormalizedDataset,
} from "./domain";
import {
  DemoWorkbenchDataSource,
  FeishuWorkbenchDataSource,
  type ProductMapping,
  type WorkbenchConfig,
  type WorkbenchDataSource,
} from "./data-source";

type Notice = { message: string; tone: "success" | "warning" | "error" };

function formatLoadedAt(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function AddProductDialog({
  open,
  initialProduct = "",
  initialDate,
  mappings,
  onClose,
  onCreate,
}: {
  open: boolean;
  initialProduct?: string;
  initialDate: string;
  mappings: ProductMapping[];
  onClose: () => void;
  onCreate: (productName: string, dateKey: string, tiktokProductId: string) => Promise<void>;
}) {
  const [productName, setProductName] = useState(initialProduct);
  const [dateKey, setDateKey] = useState(initialDate);
  const [tiktokProductId, setTiktokProductId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProductName(initialProduct);
    setDateKey(initialDate);
    setTiktokProductId(mappings.find((mapping) => mapping.productName === initialProduct)?.tiktokProductId ?? "");
  }, [initialDate, initialProduct, mappings, open]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header>
          <div>
            <span className="eyebrow">确定性新增</span>
            <h2 id="dialog-title">新增商品日记录</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <p className="dialog-intro">只创建一条“正式商品名称＋日期”原生记录，不生成指标行或影子表。保存前检查重复，保存后复读；并发产生的本插件空白重复行会安全撤回。</p>
        <label className="form-field">
          <span>正式商品名称</span>
          <input autoFocus value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="与合作表、上线表完全一致" />
        </label>
        <div className="form-grid">
          <label className="form-field">
            <span>首个录入日期</span>
            <input type="date" value={dateKey} onChange={(event) => setDateKey(event.target.value)} />
          </label>
          <label className="form-field">
            <span>TikTok 商品ID</span>
            <input inputMode="numeric" value={tiktokProductId} onChange={(event) => setTiktokProductId(event.target.value.replace(/\D/g, ""))} placeholder="8–32位数字" />
          </label>
        </div>
        <div className="mapping-note">
          <strong>映射边界</strong>
          <span>插件保存映射用于新增校验；TikTok 自动回填仍以机器人中央商品字典为准。未完成中央同步前，不会假称 API 已接通该新品。</span>
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>取消</button>
          <button
            type="button"
            className="button primary"
            disabled={submitting || !productName.trim() || !dateKey || !/^\d{8,32}$/.test(tiktokProductId)}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onCreate(productName.trim(), dateKey, tiktokProductId);
                onClose();
              } finally {
                setSubmitting(false);
              }
            }}
          >{submitting ? "复读检查中…" : "检查并创建"}</button>
        </footer>
      </section>
    </div>
  );
}

function DeleteProductDialog({
  productName,
  recordCount,
  onClose,
  onDelete,
}: {
  productName: string;
  recordCount: number;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  if (!productName) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !deleting && onClose()}>
      <section className="dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
        <header>
          <div>
            <span className="eyebrow danger-eyebrow">谨慎操作</span>
            <h2 id="delete-dialog-title">删除商品</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭" disabled={deleting}>×</button>
        </header>
        <p className="delete-dialog-message">确认删除“<strong>{productName}</strong>”的全部投产比日记录？</p>
        <p className="delete-dialog-scope">当前读取到 {recordCount} 条。不会删除红人开发、合作或上线表的数据。</p>
        <footer>
          <button type="button" className="button secondary" onClick={onClose} disabled={deleting}>取消</button>
          <button type="button" className="button danger-button" disabled={deleting} onClick={async () => {
            setDeleting(true);
            try { await onDelete(); } finally { setDeleting(false); }
          }}>{deleting ? "删除并复读中…" : "确认删除"}</button>
        </footer>
      </section>
    </div>
  );
}

function StoreSettingsDialog({
  config,
  onClose,
  onSave,
}: {
  config: WorkbenchConfig | null;
  onClose: () => void;
  onSave: (config: WorkbenchConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkbenchConfig | null>(config);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(config), [config]);
  if (!draft) return null;
  const field = (key: keyof WorkbenchConfig, label: string) => (
    <label className="form-field">
      <span>{label}</span>
      <input value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
    </label>
  );
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="store-settings-title">
        <header>
          <div><h2 id="store-settings-title">店铺配置</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={saving}>×</button>
        </header>
        {field("businessDisplayName", "工作台显示名称")}
        {field("storeAggregateLabel", "投产比店铺汇总名")}
        {field("roiTableName", "投产比原表名称")}
        <p className="dialog-intro">这里会调整公式和汇总结构，所以飞书会要求 Base 管理权限；日常填表、查询和删除商品不受这个限制。</p>
        <footer>
          <button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="button primary" disabled={saving || Object.values(draft).some((value) => !value.trim())} onClick={async () => {
            setSaving(true);
            try { await onSave(draft); } finally { setSaving(false); }
          }}>{saving ? "保存并复读中…" : "保存配置"}</button>
        </footer>
      </section>
    </div>
  );
}

function AdvertisingAccountsDialog({
  open,
  accounts,
  warnings,
  canManage,
  onClose,
  onAdd,
  onRename,
  onRemove,
  onRestore,
  onRepair,
}: {
  open: boolean;
  accounts: AdvertisingAccount[];
  warnings: string[];
  canManage: boolean;
  onClose: () => void;
  onAdd: (name: string) => Promise<void>;
  onRename: (accountId: string, name: string) => Promise<void>;
  onRemove: (accountId: string) => Promise<void>;
  onRestore: (accountId: string) => Promise<void>;
  onRepair: () => Promise<void>;
}) {
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState("");
  useEffect(() => {
    if (!open) return;
    setDrafts(Object.fromEntries(accounts.map((account) => [account.id, account.name])));
    setNewName("");
  }, [accounts, open]);
  if (!open) return null;
  const active = accounts.filter((account) => account.active);
  const archived = accounts.filter((account) => !account.active);
  const run = async (key: string, task: () => Promise<void>) => {
    setBusyKey(key);
    try { await task(); } finally { setBusyKey(""); }
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busyKey && onClose()}>
      <section className="dialog advertising-dialog" role="dialog" aria-modal="true" aria-labelledby="advertising-dialog-title">
        <header>
          <div>
            <span className="eyebrow">广告投放结构</span>
            <h2 id="advertising-dialog-title">广告账户</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={Boolean(busyKey)} aria-label="关闭">×</button>
        </header>
        <p className="dialog-intro">每个账户自动拥有“广告花费”和“广告出单量”两行；总广告花费与总广告出单量会自动汇总全部账户。改名保留原字段 ID 和历史数据。</p>
        {warnings.length > 0 && <div className="advertising-warning">
          <div className="advertising-warning-heading">
            <strong>字段需要修复</strong>
            <button type="button" disabled={!canManage || Boolean(busyKey)} onClick={() => void run("repair", onRepair)}>
              {busyKey === "repair" ? "正在补齐…" : "补齐缺失配对"}
            </button>
          </div>
          {warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>}
        <div className="advertising-account-list">
          {active.length === 0 && <div className="empty-account-state">还没有启用的广告账户</div>}
          {active.map((account) => (
            <div className="advertising-account-row" key={account.id}>
              <span className="account-status-dot" aria-hidden="true" />
              <input
                aria-label={`${account.name}名称`}
                value={drafts[account.id] ?? account.name}
                disabled={!canManage || Boolean(busyKey)}
                onChange={(event) => setDrafts((current) => ({ ...current, [account.id]: event.target.value }))}
              />
              <button
                type="button"
                className="account-action"
                disabled={!canManage || Boolean(busyKey) || (drafts[account.id] ?? account.name).trim() === account.name}
                onClick={() => void run(`rename:${account.id}`, () => onRename(account.id, drafts[account.id] ?? account.name))}
              >{busyKey === `rename:${account.id}` ? "保存中…" : "保存改名"}</button>
              <button
                type="button"
                className="account-action account-remove"
                disabled={!canManage || Boolean(busyKey)}
                title="从工作台移除；底层字段和历史数据不删除"
                onClick={() => void run(`remove:${account.id}`, () => onRemove(account.id))}
              >{busyKey === `remove:${account.id}` ? "移除中…" : "移除"}</button>
            </div>
          ))}
        </div>
        <div className="advertising-add-row">
          <input value={newName} disabled={!canManage || Boolean(busyKey)} onChange={(event) => setNewName(event.target.value)} placeholder="输入新的广告账户名称" />
          <button type="button" className="button primary" disabled={!canManage || Boolean(busyKey) || !newName.trim()} onClick={() => void run("add", async () => { await onAdd(newName); setNewName(""); })}>{busyKey === "add" ? "建立字段中…" : "＋ 新增账户"}</button>
        </div>
        {archived.length > 0 && (
          <details className="archived-accounts">
            <summary>已移除账户（{archived.length}）</summary>
            {archived.map((account) => (
              <div key={account.id}><span>{account.name}</span><button type="button" disabled={!canManage || Boolean(busyKey)} onClick={() => void run(`restore:${account.id}`, () => onRestore(account.id))}>恢复</button></div>
            ))}
          </details>
        )}
        {!canManage && <p className="advertising-permission-note">你可以照常填写广告数据；新增、改名、移除账户需要 Base 管理员权限。</p>}
        <footer>
          <span className="advertising-data-safety">移除只隐藏工作台行，历史数据与总计不会被删除。</span>
          <button type="button" className="button secondary" onClick={onClose} disabled={Boolean(busyKey)}>完成</button>
        </footer>
      </section>
    </div>
  );
}

export default function App() {
  const demoMode = new URLSearchParams(window.location.search).get("demo") === "1";
  const source = useMemo<WorkbenchDataSource>(() => demoMode
    ? new DemoWorkbenchDataSource(createDemoRecords())
    : new FeishuWorkbenchDataSource(), [demoMode]);
  const [dataset, setDataset] = useState<NormalizedDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyAnomalies, setOnlyAnomalies] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [activeMonth, setActiveMonth] = useState("");
  const [range, setRange] = useState({ start: "", end: "" });
  const [rangePreset, setRangePreset] = useState<"month" | "30" | "90" | "180">("month");
  const [notice, setNotice] = useState<Notice>({ message: "", tone: "success" });
  const [dialog, setDialog] = useState<{ open: boolean; product: string; date: string }>({ open: false, product: "", date: currentShanghaiDateKey() });
  const [deleteProductName, setDeleteProductName] = useState("");
  const [mappings, setMappings] = useState<ProductMapping[]>([]);
  const [config, setConfig] = useState<WorkbenchConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advertisingOpen, setAdvertisingOpen] = useState(false);
  const initialized = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, nextMappings, nextConfig] = await Promise.all([
        source.load(),
        source.getMappings(),
        source.getConfig(),
      ]);
      setDataset(next);
      setMappings(nextMappings);
      setConfig(nextConfig);
      if (!initialized.current) {
        const latestMonth = getLatestMonth(next.records);
        setActiveMonth(latestMonth);
        setRange(monthBounds(latestMonth));
        initialized.current = true;
      }
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    void load();
    return source.subscribe(() => void load());
  }, [load, source]);

  useEffect(() => {
    if (!notice.message) return;
    const timer = window.setTimeout(() => setNotice((current) => current.message === notice.message ? { message: "", tone: "success" } : current), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const dates = useMemo(() => range.start && range.end ? enumerateDateKeys(range.start, range.end).reverse() : [], [range]);

  const showMessage = useCallback((message: string, tone: Notice["tone"]) => setNotice({ message, tone }), []);

  const applyMonth = (month: string) => {
    setActiveMonth(month);
    setRangePreset("month");
    setRange(monthBounds(month));
  };

  const applyPreset = (preset: typeof rangePreset) => {
    setRangePreset(preset);
    if (preset === "month") setRange(monthBounds(activeMonth));
    else setRange(rollingDateBounds(currentShanghaiDateKey(), Number(preset)));
  };

  if (loading && !dataset) {
    return <main className="state-page"><div className="loader" /><h1>正在读取经营数据</h1><p>从当前飞书多维表格读取字段与原生记录，不复制业务数据。</p></main>;
  }

  if (error && !dataset) {
    return (
      <main className="state-page error-state">
        <div className="state-icon">!</div>
        <h1>暂时无法打开经营工作台</h1>
        <p>{error}</p>
        <button type="button" className="button primary" onClick={() => void load()}>重新读取</button>
        <small>未写入任何飞书记录，也未切换到静态数据。</small>
      </main>
    );
  }

  if (!dataset) return null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <i /><i /><i />
          </div>
          <div className="brand-title">{dataset.mode === "store" ? `${config?.businessDisplayName ?? "经营"}工作台` : `${dataset.aggregateLabel}账号端工作台`}</div>
          {dataset.isDemo && <span className="demo-badge">本地演示数据</span>}
        </div>
        <div className="header-status">
          <span className={`live-dot ${error ? "warning" : ""}`} />
          <span>{error ? "同步失败，保留上次数据" : `原表已同步 · ${formatLoadedAt(dataset.loadedAt)}`}</span>
          <button type="button" className="icon-button refresh-button" onClick={() => void load()} aria-label="刷新" disabled={loading}>{loading ? "…" : "↻"}</button>
          {dataset.mode === "store" && <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="店铺配置">⚙</button>}
        </div>
      </header>

      <section className="toolbar" aria-label="筛选与操作">
        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${dataset.dimensionLabel}`} aria-label={`搜索${dataset.dimensionLabel}`} />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
        </label>
        <label className="month-picker">
          <span>月份</span>
          <input type="month" value={activeMonth} onChange={(event) => applyMonth(event.target.value)} />
        </label>
        <span className="range-label">{range.start.slice(5).replace("-", "/")}—{range.end.slice(5).replace("-", "/")} · {dates.length}天</span>
        <div className="toolbar-spacer" />
        <details className="filter-menu">
          <summary className={onlyAnomalies || onlyMissing || rangePreset !== "month" ? "active" : ""}>
            筛选{(Number(onlyAnomalies) + Number(onlyMissing) + Number(rangePreset !== "month")) > 0 && <b>{Number(onlyAnomalies) + Number(onlyMissing) + Number(rangePreset !== "month")}</b>}
          </summary>
          <div className="filter-popover">
            <label className="filter-field">
              <span>日期范围</span>
              <select value={rangePreset} onChange={(event) => applyPreset(event.target.value as typeof rangePreset)}>
                <option value="month">当前整月</option>
                <option value="30">近30天</option>
                <option value="90">近90天</option>
                <option value="180">近180天</option>
              </select>
            </label>
            <label className="check-filter">
              <input type="checkbox" checked={onlyAnomalies} onChange={(event) => setOnlyAnomalies(event.target.checked)} />
              <span><strong>只看异常</strong><small>重复、负数、商品卡超量或公式不一致</small></span>
            </label>
            {dataset.mode === "store" && <label className="check-filter">
              <input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} />
              <span><strong>只看待补</strong><small>原表标记“待录入/待补数据”；可选低频字段不计</small></span>
            </label>}
          </div>
        </details>
        {dataset.mode === "store" && <button type="button" className="button primary add-button" disabled={!dataset.editable} onClick={() => setDialog({ open: true, product: "", date: range.end || currentShanghaiDateKey() })}>＋ 新增商品</button>}
        {dataset.mode === "store" && <button type="button" className="button advertising-button" onClick={() => setAdvertisingOpen(true)}>广告账户</button>}
      </section>

      <main className="workspace">
        <Matrix
          records={dataset.records}
          fieldsByName={dataset.fieldsByName}
          dates={dates}
          query={query}
          onlyAnomalies={onlyAnomalies}
          onlyMissing={onlyMissing}
          editable={dataset.editable}
          allowEnsureRecords={dataset.mode === "store"}
          canDeleteProducts={dataset.canDeleteProducts}
          advertisingAccounts={dataset.advertisingAccounts}
          productMappings={mappings}
          aggregateLabel={dataset.aggregateLabel}
          dimensionLabel={dataset.dimensionLabel}
          aggregateMetrics={dataset.aggregateMetrics}
          dimensionMetrics={dataset.dimensionMetrics}
          showProductLinks={dataset.showProductLinks}
          validateStoreFormulas={dataset.validateStoreFormulas}
          onSave={(request) => source.saveCell(request)}
          onSaved={(recordId, fieldName, value) => setDataset((current) => current ? {
            ...current,
            records: current.records.map((record) => record.recordId === recordId ? { ...record, values: { ...record.values, [fieldName]: value } } : record),
            loadedAt: new Date(),
          } : current)}
          onEnsureRecord={async (product, date) => {
            if (product === dataset.aggregateLabel) {
              try {
                const result = await source.createDailyRecord({ productName: product, dateKey: date });
                showMessage(result.message, "success");
                await load();
              } catch (createError) {
                showMessage(createError instanceof Error ? createError.message : String(createError), "error");
              }
              return;
            }
            const mapping = mappings.find((item) => item.productName === product);
            if (!mapping) {
              setDialog({ open: true, product, date });
              showMessage("该商品尚无 TikTok 商品ID映射，请先完成确定性映射", "warning");
              return;
            }
            try {
              const result = await source.createDailyRecord({ productName: product, dateKey: date, tiktokProductId: mapping.tiktokProductId });
              showMessage(result.message, "success");
              await load();
            } catch (createError) {
              showMessage(createError instanceof Error ? createError.message : String(createError), "error");
            }
          }}
          onDeleteProduct={setDeleteProductName}
          onMessage={showMessage}
        />
      </main>

      {notice.message && <div className={`notice-toast notice-${notice.tone}`} role="status">{notice.message}</div>}

      {dataset.mode === "store" && <AddProductDialog
        open={dialog.open}
        initialProduct={dialog.product}
        initialDate={dialog.date}
        mappings={mappings}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
        onCreate={async (productName, dateKey, tiktokProductId) => {
          try {
            const result = await source.createDailyRecord({ productName, dateKey, tiktokProductId });
            showMessage(result.message, "success");
            await source.notify(result.message, "success");
            await load();
          } catch (createError) {
            const message = createError instanceof Error ? createError.message : String(createError);
            showMessage(message, "error");
            await source.notify(message, "error");
            throw createError;
          }
        }}
      />}
      {dataset.mode === "store" && <DeleteProductDialog
        productName={deleteProductName}
        recordCount={dataset.records.filter((record) => record.product === deleteProductName).length}
        onClose={() => setDeleteProductName("")}
        onDelete={async () => {
          try {
            const result = await source.deleteProduct(deleteProductName);
            showMessage(result.message, "success");
            await source.notify(result.message, "success");
            setDeleteProductName("");
            await load();
          } catch (deleteError) {
            const message = deleteError instanceof Error ? deleteError.message : String(deleteError);
            showMessage(message, "error");
            await source.notify(message, "error");
            throw deleteError;
          }
        }}
      />}
      {dataset.mode === "store" && settingsOpen && <StoreSettingsDialog
        config={config}
        onClose={() => setSettingsOpen(false)}
        onSave={async (nextConfig) => {
          try {
            await source.saveConfig(nextConfig);
            setConfig(nextConfig);
            setSettingsOpen(false);
            showMessage("店铺配置已保存并复读验证", "success");
            await load();
          } catch (configError) {
            const message = configError instanceof Error ? configError.message : String(configError);
            showMessage(message, "error");
            throw configError;
          }
        }}
      />}
      {dataset.mode === "store" && <AdvertisingAccountsDialog
        open={advertisingOpen}
        accounts={dataset.advertisingAccounts}
        warnings={dataset.advertisingWarnings}
        canManage={dataset.canManageAdvertising}
        onClose={() => setAdvertisingOpen(false)}
        onAdd={async (name) => {
          try {
            const result = await source.addAdvertisingAccount(name);
            showMessage(result.message, "success");
            await source.notify(result.message, "success");
            await load();
          } catch (accountError) {
            const message = accountError instanceof Error ? accountError.message : String(accountError);
            showMessage(message, "error");
            await source.notify(message, "error");
            throw accountError;
          }
        }}
        onRename={async (accountId, name) => {
          try {
            const result = await source.renameAdvertisingAccount(accountId, name);
            showMessage(result.message, "success");
            await load();
          } catch (accountError) {
            const message = accountError instanceof Error ? accountError.message : String(accountError);
            showMessage(message, "error");
            throw accountError;
          }
        }}
        onRemove={async (accountId) => {
          try {
            const result = await source.removeAdvertisingAccount(accountId);
            showMessage(result.message, "success");
            await load();
          } catch (accountError) {
            const message = accountError instanceof Error ? accountError.message : String(accountError);
            showMessage(message, "error");
            throw accountError;
          }
        }}
        onRestore={async (accountId) => {
          try {
            const result = await source.restoreAdvertisingAccount(accountId);
            showMessage(result.message, "success");
            await load();
          } catch (accountError) {
            const message = accountError instanceof Error ? accountError.message : String(accountError);
            showMessage(message, "error");
            throw accountError;
          }
        }}
        onRepair={async () => {
          try {
            const result = await source.repairAdvertisingAccounts();
            showMessage(result.message, "success");
            await source.notify(result.message, "success");
            await load();
          } catch (accountError) {
            const message = accountError instanceof Error ? accountError.message : String(accountError);
            showMessage(message, "error");
            await source.notify(message, "error");
            throw accountError;
          }
        }}
      />}
    </div>
  );
}
