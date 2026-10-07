export function resolveCommandAction(
  args: readonly string[],
  options: { applyFlag?: string; fallback: string; ignoredFlags?: readonly string[] },
): string {
  const applyFlag = options.applyFlag ?? "--apply";
  if (args.includes(applyFlag)) return applyFlag;
  const ignored = new Set(options.ignoredFlags ?? ["--confirm"]);
  return args.find((value) => value.startsWith("--") && !ignored.has(value)) ?? options.fallback;
}
