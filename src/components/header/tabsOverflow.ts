const OVERFLOW_SLACK_PX = 1;

/**
 * Whether tab-row content exceeds the wrapper at unconstrained sizes.
 *
 * Compact rules (e.g. max-width on passive tabs) are keyed off
 * `data-overflowing`, so this temporarily clears that flag to avoid
 * compact ↔ expand oscillation.
 */
export function isTabRowOverflowing(
  el: HTMLElement,
  slackPx = OVERFLOW_SLACK_PX,
): boolean {
  const previous = el.getAttribute('data-overflowing');
  if (previous !== 'false') {
    el.setAttribute('data-overflowing', 'false');
  }
  const overflowing = el.scrollWidth > el.clientWidth + slackPx;
  if (previous === null) {
    el.removeAttribute('data-overflowing');
  } else if (previous !== 'false') {
    el.setAttribute('data-overflowing', previous);
  }
  return overflowing;
}
