export class ClarificationError extends Error {
  public readonly name = "ClarificationError";

  public constructor(
    public readonly prompt: string,
    public readonly options: string[] = [],
  ) {
    super(prompt);
  }
}

export function isClarificationError(error: unknown): error is ClarificationError {
  return error instanceof ClarificationError || (
    error instanceof Error && error.name === "ClarificationError" && "prompt" in error
  );
}
