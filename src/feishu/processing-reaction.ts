import type { Client } from "@larksuiteoapi/node-sdk";

export const PROCESSING_REACTION_EMOJI = "Typing";

type MessageReactionApi = Pick<Client, "im">;

/**
 * Adds a temporary reaction while the bot is working. Failures are
 * best-effort and must never block the actual reply.
 */
export class ProcessingReactionService {
  public constructor(
    private readonly client: MessageReactionApi,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  public async add(messageId: string): Promise<string | null> {
    try {
      const response = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: {
            emoji_type: PROCESSING_REACTION_EMOJI,
          },
        },
      });
      assertReactionResponse(response, "add");
      const reactionId = response.data?.reaction_id;
      if (!reactionId) throw new Error("Feishu returned no reaction_id");
      return reactionId;
    } catch (error) {
      this.warn(`[processing-reaction] add skipped: ${describeError(error)}`);
      return null;
    }
  }

  public async remove(messageId: string, reactionId: string): Promise<void> {
    try {
      const response = await this.client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
      assertReactionResponse(response, "remove");
    } catch (error) {
      this.warn(`[processing-reaction] remove skipped: ${describeError(error)}`);
    }
  }
}

function assertReactionResponse(
  response: { code?: number; msg?: string },
  action: string,
): void {
  if (response.code && response.code !== 0) {
    throw new Error(`${action} failed (${response.code}): ${response.msg ?? "unknown error"}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
