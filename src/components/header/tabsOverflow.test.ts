import { describe, expect, it } from 'vitest';
import { isTabRowOverflowing } from './tabsOverflow';

function mockRow(options: {
  unconstrainedScroll: number;
  compactScroll: number;
  clientWidth: number;
  overflowing: string | null;
}): HTMLElement {
  const el = document.createElement('div');
  if (options.overflowing !== null) {
    el.setAttribute('data-overflowing', options.overflowing);
  }
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    get: () => options.clientWidth,
  });
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    get: () =>
      el.getAttribute('data-overflowing') === 'true'
        ? options.compactScroll
        : options.unconstrainedScroll,
  });
  return el;
}

describe('isTabRowOverflowing', () => {
  it('reports overflow from unconstrained width even when compact mode would fit', () => {
    const el = mockRow({
      unconstrainedScroll: 400,
      compactScroll: 200,
      clientWidth: 240,
      overflowing: 'true',
    });
    expect(isTabRowOverflowing(el)).toBe(true);
    expect(el.getAttribute('data-overflowing')).toBe('true');
  });

  it('clears overflow when unconstrained content fits the wrapper', () => {
    const el = mockRow({
      unconstrainedScroll: 180,
      compactScroll: 120,
      clientWidth: 240,
      overflowing: 'true',
    });
    expect(isTabRowOverflowing(el)).toBe(false);
    expect(el.getAttribute('data-overflowing')).toBe('true');
  });

  it('detects overflow before compact mode is applied', () => {
    const el = mockRow({
      unconstrainedScroll: 400,
      compactScroll: 200,
      clientWidth: 240,
      overflowing: 'false',
    });
    expect(isTabRowOverflowing(el)).toBe(true);
    expect(el.getAttribute('data-overflowing')).toBe('false');
  });
});
