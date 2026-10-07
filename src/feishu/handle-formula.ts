/**
 * Normalizes a TikTok handle inside a Feishu Bitable formula.
 *
 * Handles are identifiers, so spaces, tabs and line breaks are never
 * significant.  The duplicate-cell marker (U+2063), an optional leading @,
 * and letter casing are also ignored.  Keep this expression shared by every
 * cross-table creator lookup so visually identical handles cannot diverge.
 */
export function normalizeHandleFormula(expression: string): string {
  const withoutDuplicateMarker = `SUBSTITUTE(${expression},"⁣","")`;
  const withoutLineFeed = `SUBSTITUTE(${withoutDuplicateMarker},CHAR(10),"")`;
  const withoutCarriageReturn = `SUBSTITUTE(${withoutLineFeed},CHAR(13),"")`;
  const withoutTab = `SUBSTITUTE(${withoutCarriageReturn},CHAR(9),"")`;
  const withoutSpaces = `SUBSTITUTE(${withoutTab}," ","")`;
  const withoutAt = `SUBSTITUTE(${withoutSpaces},"@","")`;
  return `LOWER(${withoutAt})`;
}

export interface OnlineCooperationLookupFormulaFields {
  cooperationTableId: string;
  onlineTableId: string;
  cooperationCreatorFieldId: string;
  cooperationValueFieldId: string;
  onlineCreatorFieldId: string;
}

export function buildOnlineCooperationLookupFormula(
  fields: OnlineCooperationLookupFormulaFields,
): string {
  const onlineCreator = `bitable::$table[${fields.onlineTableId}].$field[${fields.onlineCreatorFieldId}]`;
  const normalizedOnlineCreator = normalizeHandleFormula(onlineCreator);
  const normalizedSourceCreator = normalizeHandleFormula(
    `CurrentValue.$column[${fields.cooperationCreatorFieldId}]`,
  );
  const match = `bitable::$table[${fields.cooperationTableId}]`
    + `.FILTER(${normalizedSourceCreator}=${normalizedOnlineCreator})`
    + `.$column[${fields.cooperationValueFieldId}].FIRST()`;
  return `IF(${normalizedOnlineCreator}="","",${match})`;
}
