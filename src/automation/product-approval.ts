import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ModelProvider } from "../ai/types.js";
import { requireCanonicalProductName } from "../business/product-naming.js";
import type { BusinessProfile } from "../config/business-profile.js";
import type { ProductCatalogMap, UnmappedCatalogProduct } from "./product-catalog.js";

export interface PendingProductApproval {
  productId: string;
  sourceTitle: string;
  suggestedName: string | null;
  firstSeenDate: string;
  lastSeenDate: string;
}

interface StoredProductApproval extends PendingProductApproval {
  state: "pending" | "confirmed";
  confirmedName: string | null;
  backfillRequired?: boolean;
  backfillCompletedThrough?: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

interface ProductApprovalState {
  schemaVersion: 1;
  items: Record<string, StoredProductApproval>;
  catalogBaselineIds?: string[];
}

export interface StageProductApprovalResult {
  pending: PendingProductApproval[];
  autoConfirmed: Array<{ productId: string; canonicalName: string }>;
}

export interface AutoEnrollCatalogResult {
  baselineInitialized: boolean;
  autoConfirmed: Array<{ productId: string; canonicalName: string }>;
}

export interface ConfirmProductApprovalResult {
  productId: string;
  canonicalName: string;
  alreadyConfirmed: boolean;
  firstSeenDate: string | null;
}

const locks = new Map<string, Promise<void>>();

export class ProductApprovalService {
  private readonly statePath: string;
  private readonly mapPath: string;

  public constructor(
    private readonly profile: BusinessProfile,
    private readonly tenantId: string,
    private readonly provider?: ModelProvider,
  ) {
    this.statePath = path.resolve(".runtime", "tenants", tenantId, "product-approvals.json");
    this.mapPath = path.resolve(process.cwd(), profile.tiktok.productMapFile);
  }

  public async stage(
    products: UnmappedCatalogProduct[],
    observedDate: string,
  ): Promise<StageProductApprovalResult> {
    return this.serialized(async () => {
      const map = await this.readMap();
      const state = await this.readState();
      const autoConfirmed: StageProductApprovalResult["autoConfirmed"] = [];
      let mapChanged = false;
      for (const product of products) {
        if (map.products[product.id]) continue;
        const exactName = exactConfirmedName(map, product.sourceTitle);
        if (exactName) {
          map.products[product.id] = exactName;
          map.sourceTitles ??= {};
          map.sourceTitles[product.id] = product.sourceTitle;
          state.items[product.id] = confirmedItem(product, observedDate, exactName, "exact-title-match");
          autoConfirmed.push({ productId: product.id, canonicalName: exactName });
          mapChanged = true;
          continue;
        }
        const existing = state.items[product.id];
        const suggestion = existing?.suggestedName
          ?? await this.suggest(product.sourceTitle, Object.values(map.products));
        state.items[product.id] = {
          productId: product.id,
          sourceTitle: product.sourceTitle,
          suggestedName: suggestion,
          firstSeenDate: existing?.firstSeenDate ?? observedDate,
          lastSeenDate: observedDate,
          state: "pending",
          confirmedName: null,
          updatedAt: new Date().toISOString(),
          updatedBy: null,
        };
      }
      if (mapChanged) await atomicJsonWrite(this.mapPath, map);
      await atomicJsonWrite(this.statePath, state);
      return { pending: pendingItems(state), autoConfirmed };
    });
  }

  public async autoEnrollCatalog(
    rows: Array<Record<string, unknown>>,
    observedDate: string,
  ): Promise<AutoEnrollCatalogResult> {
    if (!this.profile.tiktok.autoEnrollNewProducts) {
      return { baselineInitialized: false, autoConfirmed: [] };
    }
    return this.serialized(async () => {
      const map = await this.readMap();
      const state = await this.readState();
      const catalogIds = rows
        .map((row) => String(row.id ?? row.product_id ?? "").trim())
        .filter((id) => /^\d+$/.test(id));
      if (!state.catalogBaselineIds) {
        state.catalogBaselineIds = [...new Set(catalogIds)].sort();
        await atomicJsonWrite(this.statePath, state);
        return { baselineInitialized: true, autoConfirmed: [] };
      }

      const baseline = new Set(state.catalogBaselineIds);
      for (const id of Object.keys(map.products)) baseline.add(id);
      const usedNames = new Set(Object.values(map.products).map((name) => String(name).trim()));
      const autoConfirmed: AutoEnrollCatalogResult["autoConfirmed"] = [];
      let mapChanged = false;
      for (const row of rows) {
        const productId = String(row.id ?? row.product_id ?? "").trim();
        if (!/^\d+$/.test(productId) || baseline.has(productId) || map.products[productId]) continue;
        const status = String(row.status ?? row.product_status ?? "").trim();
        if (status !== "ACTIVATE" || row.is_not_for_sale === true) continue;
        const sourceTitle = String(row.title ?? row.name ?? row.product_name ?? "").trim()
          || `TikTok商品${productId.slice(-8)}`;
        const suggested = await this.suggest(sourceTitle, [...usedNames]);
        const canonicalName = uniqueAutoName(suggested, productId, usedNames);
        map.products[productId] = canonicalName;
        map.sourceTitles ??= {};
        map.sourceTitles[productId] = sourceTitle;
        state.items[productId] = confirmedItem(
          { id: productId, sourceTitle },
          observedDate,
          canonicalName,
          "auto-catalog",
        );
        baseline.add(productId);
        usedNames.add(canonicalName);
        autoConfirmed.push({ productId, canonicalName });
        mapChanged = true;
      }
      state.catalogBaselineIds = [...baseline].sort();
      if (mapChanged) await atomicJsonWrite(this.mapPath, map);
      await atomicJsonWrite(this.statePath, state);
      return { baselineInitialized: false, autoConfirmed };
    });
  }

  public async listPending(): Promise<PendingProductApproval[]> {
    return pendingItems(await this.readState());
  }

  public async requiredBackfillStartDate(): Promise<string | null> {
    const dates = Object.values((await this.readState()).items)
      .filter((item) => item.state === "confirmed" && item.backfillRequired === true)
      .map((item) => item.firstSeenDate)
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .sort();
    return dates[0] ?? null;
  }

  public async markBackfillCompletedThrough(endDate: string): Promise<void> {
    await this.serialized(async () => {
      const state = await this.readState();
      let changed = false;
      for (const [id, item] of Object.entries(state.items)) {
        if (item.state !== "confirmed" || item.backfillRequired !== true || item.firstSeenDate > endDate) continue;
        state.items[id] = {
          ...item,
          backfillRequired: false,
          backfillCompletedThrough: endDate,
          updatedAt: new Date().toISOString(),
        };
        changed = true;
      }
      if (changed) await atomicJsonWrite(this.statePath, state);
    });
  }

  public async confirm(
    productId: string,
    requestedName: string,
    updatedBy: string,
  ): Promise<ConfirmProductApprovalResult> {
    return this.serialized(async () => {
      const canonicalName = requireCanonicalProductName(requestedName);
      const map = await this.readMap();
      const state = await this.readState();
      const existingName = String(map.products[productId] ?? "").trim();
      const item = state.items[productId];
      if (existingName) {
        return {
          productId,
          canonicalName: existingName,
          alreadyConfirmed: true,
          firstSeenDate: item?.firstSeenDate ?? null,
        };
      }
      if (!item || item.state !== "pending") throw new Error("这个商品不在待确认列表里，请先发送“待确认商品”刷新。");
      map.products[productId] = canonicalName;
      map.sourceTitles ??= {};
      map.sourceTitles[productId] = item.sourceTitle;
      state.items[productId] = {
        ...item,
        state: "confirmed",
        confirmedName: canonicalName,
        backfillRequired: true,
        backfillCompletedThrough: null,
        updatedAt: new Date().toISOString(),
        updatedBy,
      };
      await atomicJsonWrite(this.mapPath, map);
      await atomicJsonWrite(this.statePath, state);
      return {
        productId,
        canonicalName,
        alreadyConfirmed: false,
        firstSeenDate: item.firstSeenDate,
      };
    });
  }

  private async suggest(sourceTitle: string, existingNames: string[]): Promise<string | null> {
    const suggested = await this.provider?.suggestProductName?.(sourceTitle, existingNames);
    if (!suggested?.name) return null;
    try {
      return requireCanonicalProductName(suggested.name);
    } catch {
      return null;
    }
  }

  private async readMap(): Promise<ProductCatalogMap> {
    const raw = JSON.parse(await readFile(this.mapPath, "utf8")) as ProductCatalogMap;
    if (!raw.shop || !raw.products || typeof raw.products !== "object") throw new Error("商品映射文件格式无效");
    return { ...raw, sourceTitles: raw.sourceTitles ?? {} };
  }

  private async readState(): Promise<ProductApprovalState> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as ProductApprovalState;
      return raw.schemaVersion === 1 && raw.items && typeof raw.items === "object"
        ? raw
        : { schemaVersion: 1, items: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, items: {} };
      throw error;
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const prior = locks.get(this.statePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    locks.set(this.statePath, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(this.statePath) === queued) locks.delete(this.statePath);
    }
  }
}

function exactConfirmedName(map: ProductCatalogMap, sourceTitle: string): string | null {
  const normalized = normalizeTitle(sourceTitle);
  if (!normalized) return null;
  const matches = new Set<string>();
  for (const [id, knownTitle] of Object.entries(map.sourceTitles ?? {})) {
    if (normalizeTitle(knownTitle) === normalized && map.products[id]) matches.add(map.products[id]);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function normalizeTitle(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function uniqueAutoName(
  suggested: string | null,
  productId: string,
  usedNames: ReadonlySet<string>,
): string {
  let base = suggested;
  if (base) {
    try { base = requireCanonicalProductName(base); } catch { base = null; }
  }
  const suffix = productId.slice(-7);
  if (!base) return `商品${suffix}`;
  if (!usedNames.has(base)) return base;
  const compact = base.slice(0, Math.max(1, 24 - suffix.length - 2));
  return `${compact}(${suffix})`;
}

function confirmedItem(
  product: UnmappedCatalogProduct,
  observedDate: string,
  canonicalName: string,
  updatedBy: string,
): StoredProductApproval {
  return {
    productId: product.id,
    sourceTitle: product.sourceTitle,
    suggestedName: canonicalName,
    firstSeenDate: observedDate,
    lastSeenDate: observedDate,
    state: "confirmed",
    confirmedName: canonicalName,
    backfillRequired: true,
    backfillCompletedThrough: null,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
}

function pendingItems(state: ProductApprovalState): PendingProductApproval[] {
  return Object.values(state.items)
    .filter((item) => item.state === "pending")
    .sort((left, right) => left.firstSeenDate.localeCompare(right.firstSeenDate) || left.productId.localeCompare(right.productId))
    .map(({ productId, sourceTitle, suggestedName, firstSeenDate, lastSeenDate }) => ({
      productId, sourceTitle, suggestedName, firstSeenDate, lastSeenDate,
    }));
}

async function atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(String(code))) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25 * (attempt + 1)));
    }
  }
}
