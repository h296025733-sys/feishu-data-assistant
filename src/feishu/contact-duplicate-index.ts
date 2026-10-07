export interface IndexedContactRecord {
  recordId: string;
  value: string;
}

export interface ContactIndexUpdate {
  recordId: string;
  value: string | null;
}

export interface ContactIndexDelta {
  changedRecords: number;
  impactedNormalizedValues: Set<string>;
  currentValues: Set<string>;
}

export interface ContactIndexStats {
  totalRecords: number;
  nonblankRecords: number;
  normalizedValues: number;
  duplicateGroups: number;
  duplicateRecords: number;
}

export interface BitableRecordChangeEvent {
  event_id?: string;
  create_time?: string;
  file_token?: string;
  table_id?: string;
  revision?: number;
  update_time?: number;
  operator_id?: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  action_list?: Array<{
    record_id?: string;
    action?: string;
    before_value?: Array<{ field_id?: string; field_value?: string }>;
    after_value?: Array<{ field_id?: string; field_value?: string }>;
  }>;
}

export interface CollectedRecordChanges {
  recordIds: Set<string>;
  requiresFullReconciliation: boolean;
}

export class ContactCountIndex {
  private readonly records = new Map<string, string>();
  private readonly normalizedCounts = new Map<string, number>();
  private nonblankRecords = 0;

  public constructor(
    private readonly normalize: (value: unknown) => string,
  ) {}

  public reset(records: readonly IndexedContactRecord[]): void {
    this.records.clear();
    this.normalizedCounts.clear();
    this.nonblankRecords = 0;
    for (const record of records) {
      this.records.set(record.recordId, record.value);
      this.increment(record.value);
    }
  }

  public apply(updates: readonly ContactIndexUpdate[]): ContactIndexDelta {
    const impactedNormalizedValues = new Set<string>();
    const currentValues = new Set<string>();
    let changedRecords = 0;

    for (const update of updates) {
      const oldValue = this.records.get(update.recordId);
      const newValue = update.value;
      if (newValue === null) {
        if (oldValue === undefined) continue;
        this.decrement(oldValue, impactedNormalizedValues);
        this.records.delete(update.recordId);
        changedRecords += 1;
        continue;
      }

      if (oldValue === newValue) continue;
      if (oldValue !== undefined) this.decrement(oldValue, impactedNormalizedValues);
      this.records.set(update.recordId, newValue);
      this.increment(newValue, impactedNormalizedValues);
      if (newValue.trim()) currentValues.add(newValue.trim());
      changedRecords += 1;
    }

    return { changedRecords, impactedNormalizedValues, currentValues };
  }

  public count(normalizedValue: string): number {
    return this.normalizedCounts.get(normalizedValue) ?? 0;
  }

  public stats(): ContactIndexStats {
    let duplicateGroups = 0;
    let duplicateRecords = 0;
    for (const count of this.normalizedCounts.values()) {
      if (count <= 1) continue;
      duplicateGroups += 1;
      duplicateRecords += count;
    }
    return {
      totalRecords: this.records.size,
      nonblankRecords: this.nonblankRecords,
      normalizedValues: this.normalizedCounts.size,
      duplicateGroups,
      duplicateRecords,
    };
  }

  private increment(value: string, impacted?: Set<string>): void {
    const normalized = this.normalize(value);
    if (!normalized) return;
    this.nonblankRecords += 1;
    this.normalizedCounts.set(normalized, (this.normalizedCounts.get(normalized) ?? 0) + 1);
    impacted?.add(normalized);
  }

  private decrement(value: string, impacted: Set<string>): void {
    const normalized = this.normalize(value);
    if (!normalized) return;
    this.nonblankRecords = Math.max(0, this.nonblankRecords - 1);
    const next = (this.normalizedCounts.get(normalized) ?? 0) - 1;
    if (next > 0) this.normalizedCounts.set(normalized, next);
    else this.normalizedCounts.delete(normalized);
    impacted.add(normalized);
  }
}

export function collectContactRecordChanges(
  event: BitableRecordChangeEvent,
  contactFieldId: string | null,
): CollectedRecordChanges {
  const recordIds = new Set<string>();
  let requiresFullReconciliation = false;
  const actions = event.action_list ?? [];
  if (actions.length === 0) return { recordIds, requiresFullReconciliation: true };

  for (const action of actions) {
    const actionName = String(action.action ?? "").toLocaleLowerCase("en-US");
    const fields = [...(action.before_value ?? []), ...(action.after_value ?? [])];
    const isLifecycleChange = actionName.includes("add") || actionName.includes("delete");
    const touchesContact = isLifecycleChange
      || fields.length === 0
      || contactFieldId === null
      || fields.some((field) => field.field_id === contactFieldId);
    if (!touchesContact) continue;

    const recordId = String(action.record_id ?? "").trim();
    if (recordId) recordIds.add(recordId);
    else requiresFullReconciliation = true;
  }

  return { recordIds, requiresFullReconciliation };
}
