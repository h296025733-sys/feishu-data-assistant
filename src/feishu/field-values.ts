/**
 * Feishu Text fields accept a plain string, while Url fields accept the
 * structured link payload. New Bases can legitimately use either shape for
 * the same visible column, so writers must follow the live schema.
 */
export function linkValueForField(
  url: string,
  fieldType: number | null | undefined,
  text = url,
): string | { text: string; link: string } {
  return Number(fieldType) === 1 ? url : { text, link: url };
}

export function numberValueForField(
  value: number,
  fieldType: number | null | undefined,
): number | string {
  return Number(fieldType) === 1 ? String(value) : value;
}

export function dateValueForField(
  date: string,
  timestamp: number,
  fieldType: number | null | undefined,
): number | string {
  return Number(fieldType) === 1 ? date : timestamp;
}
