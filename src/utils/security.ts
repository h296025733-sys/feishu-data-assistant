const SENSITIVE_PATTERNS = [
  /姓名|^名字$|联系人/i,
  /达人|红人|开发人|负责人|最终归属|主页|主页链接|mcn/i,
  /手机|手机号|电话|联系方式/i,
  /地址|收件|收货/i,
  /身份证|证件号/i,
  /银行|卡号|账号/i,
  /paypal/i,
  /邮箱|邮件/i,
  /客户备注|备注/i,
];

export function isSensitiveField(header: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(header));
}

export function filterSensitiveHeaders(headers: string[]): string[] {
  return headers.filter((header) => !isSensitiveField(header));
}
