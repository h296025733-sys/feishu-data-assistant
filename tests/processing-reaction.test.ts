import { describe, expect, it } from "vitest";
import {
  PROCESSING_REACTION_EMOJI,
  ProcessingReactionService,
} from "../src/feishu/processing-reaction.js";

function createClient(
  createResult: { code?: number; msg?: string; data?: { reaction_id?: string } } = {
    code: 0,
    data: { reaction_id: "reaction-1" },
  },
  deleteResult: { code?: number; msg?: string } = { code: 0 },
) {
  const createCalls: unknown[][] = [];
  const deleteCalls: unknown[][] = [];
  return {
    createCalls,
    deleteCalls,
    im: {
      messageReaction: {
        create: async (...args: unknown[]) => {
          createCalls.push(args);
          return createResult;
        },
        delete: async (...args: unknown[]) => {
          deleteCalls.push(args);
          return deleteResult;
        },
      },
    },
  };
}

describe("ProcessingReactionService", () => {
  it("adds the processing reaction and removes the exact returned reaction", async () => {
    const client = createClient();
    const service = new ProcessingReactionService(client as never);

    const reactionId = await service.add("message-1");
    expect(reactionId).toBe("reaction-1");
    expect(client.createCalls).toEqual([[{
      path: { message_id: "message-1" },
      data: {
        reaction_type: {
          emoji_type: PROCESSING_REACTION_EMOJI,
        },
      },
    }]]);

    await service.remove("message-1", reactionId!);
    expect(client.deleteCalls).toEqual([[{
      path: {
        message_id: "message-1",
        reaction_id: "reaction-1",
      },
    }]]);
  });

  it("does not block replies when adding a reaction is unauthorized", async () => {
    const warnings: string[] = [];
    const client = createClient({ code: 99991672, msg: "permission denied" });
    const service = new ProcessingReactionService(client as never, (message) => warnings.push(message));

    await expect(service.add("message-1")).resolves.toBeNull();
    expect(warnings[0]).toContain("permission denied");
  });

  it("does not throw when removing the temporary reaction fails", async () => {
    const warnings: string[] = [];
    const client = createClient(undefined, { code: 231002, msg: "no permission" });
    const service = new ProcessingReactionService(client as never, (message) => warnings.push(message));

    await expect(service.remove("message-1", "reaction-1")).resolves.toBeUndefined();
    expect(warnings[0]).toContain("no permission");
  });
});
