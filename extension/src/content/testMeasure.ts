// Test helper: jsdom has no layout, so tests measure fields from their inline style.
import type { Measure } from "./fields";

/** jsdom has no layout: a field is 200 x 32 at (100, 100) unless its inline style says other. */
export const fakeMeasure: Measure = {
  rect(el) {
    const s = (el as HTMLElement).style;
    const n = (v: string, d: number) => (v && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);
    const left = n(s.left, 100);
    const top = n(s.top, 100);
    const width = n(s.width, 200);
    const height = n(s.height, 32);
    return { left, top, width, height, right: left + width, bottom: top + height };
  },
};
