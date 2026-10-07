import { normalizeHandleFormula } from "./handle-formula.js";

export interface OnlineDeveloperFormulaFields {
  developmentTableId: string;
  onlineTableId: string;
  developmentCreatorFieldId: string;
  developmentFinalOwnerFieldId: string;
  developmentSecondOwnerFieldId: string;
  developmentFirstOwnerFieldId: string;
  onlineCreatorFieldId: string;
}

export function buildOnlineDeveloperFormula(fields: OnlineDeveloperFormulaFields): string {
  const onlineCreator = `bitable::$table[${fields.onlineTableId}].$field[${fields.onlineCreatorFieldId}]`;
  const normalizedOnlineCreator = normalizeHandleFormula(onlineCreator);
  const normalizedDevelopmentCreator = normalizeHandleFormula(
    `CurrentValue.$column[${fields.developmentCreatorFieldId}]`,
  );
  const matchingOwner = (ownerFieldId: string): string => (
    `bitable::$table[${fields.developmentTableId}]`
    + `.FILTER(${normalizedDevelopmentCreator}=${normalizedOnlineCreator})`
    + `.$column[${ownerFieldId}].FIRST()`
  );
  const finalOwner = matchingOwner(fields.developmentFinalOwnerFieldId);
  const secondOwner = matchingOwner(fields.developmentSecondOwnerFieldId);
  const firstOwner = matchingOwner(fields.developmentFirstOwnerFieldId);
  return `IF(${normalizedOnlineCreator}="","",IF(${finalOwner}!="",${finalOwner},IF(${secondOwner}!="",${secondOwner},${firstOwner})))`;
}
