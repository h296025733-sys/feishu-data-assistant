export function currencyDisplayName(currencyCode: string | null | undefined): string | null {
  const code = String(currencyCode ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const names: Record<string, string> = {
    USD: "美元",
    CNY: "人民币",
    EUR: "欧元",
    GBP: "英镑",
    JPY: "日元",
  };
  return `${names[code] ?? code}（${code}）`;
}

export function isMoneyField(fieldName: string | null | undefined): boolean {
  return /销售额|成交额|GMV|金额|花费|佣金|成本|利润|收入|退款金额/i.test(String(fieldName ?? ""));
}

export function formatCurrencyAmount(value: number, currencyCode: string | null | undefined): string {
  const amount = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  const label = currencyDisplayName(currencyCode);
  return label ? `${amount} ${label}` : amount;
}
