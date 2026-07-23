type ScrollPosition = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export function pinConversationToBottom(target: ScrollPosition | null): boolean {
  if (!target) return false;
  const bottom = Math.max(0, target.scrollHeight - target.clientHeight);
  if (Math.abs(target.scrollTop - bottom) < 1) return false;
  target.scrollTop = bottom;
  return true;
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
