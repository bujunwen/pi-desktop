import { describe, expect, it } from "vitest";
import { pinConversationToBottom, shouldFollowOutput } from "../src/renderer/src/scroll";

describe("pinConversationToBottom", () => {
  it("only writes the scroll position when it is not already pinned", () => {
    const target = { scrollHeight: 1000, scrollTop: 500, clientHeight: 400 };
    expect(pinConversationToBottom(target)).toBe(true);
    expect(target.scrollTop).toBe(600);
    expect(pinConversationToBottom(target)).toBe(false);
  });
});

describe("shouldFollowOutput", () => {
  it("resumes following when the reader returns to the bottom", () => {
    expect(shouldFollowOutput(false, 400, {
      scrollHeight: 1000,
      scrollTop: 500,
      clientHeight: 500,
    })).toBe(true);
  });

  it("only stops following when the reader scrolls upward", () => {
    expect(shouldFollowOutput(true, 500, {
      scrollHeight: 1100,
      scrollTop: 500,
      clientHeight: 500,
    })).toBe(true);
    expect(shouldFollowOutput(true, 500, {
      scrollHeight: 1100,
      scrollTop: 420,
      clientHeight: 500,
    })).toBe(false);
  });
});
