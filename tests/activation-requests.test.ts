import { describe, expect, it } from "vitest";
import { ActivationRequests } from "../src/renderer/src/activation-requests";

describe("ActivationRequests", () => {
  it("only accepts the latest activation request", () => {
    const requests = new ActivationRequests();
    const first = requests.begin();
    const second = requests.begin();

    expect(requests.current()).toBe(second);
    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(second)).toBe(true);
  });
});
