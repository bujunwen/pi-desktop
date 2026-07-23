import { describe, expect, it, vi } from "vitest";
import { positionLatestPrompt, shouldFollowOutput } from "../src/renderer/src/scroll";

describe("positionLatestPrompt", () => {
  it("does not leak Chromium's scroll promise into a React effect cleanup", () => {
    const scrollIntoView = vi.fn(() => Promise.resolve());
    const target = { scrollIntoView } as unknown as Pick<HTMLElement, "scrollIntoView">;

    expect(positionLatestPrompt(target)).toBeUndefined();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
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
