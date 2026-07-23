type ScrollTarget = Pick<HTMLElement, "scrollIntoView">;
type ScrollPosition = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export function positionLatestPrompt(target: ScrollTarget | null): void {
  target?.scrollIntoView({ block: "end" });
}

export function shouldFollowOutput(
  currentlyFollowing: boolean,
  previousScrollTop: number,
  target: ScrollPosition,
): boolean {
  const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight <= 32;
  if (atBottom) return true;
  if (target.scrollTop < previousScrollTop) return false;
  return currentlyFollowing;
}
