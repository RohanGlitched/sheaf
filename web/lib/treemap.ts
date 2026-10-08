/**
 * Squarified treemap, after Bruls, Huizing and van Wijk (2000).
 *
 * A mosaic wants sheaves that are close to square: a long thin sliver is hard to
 * read, hard to label, and hard to hit with a cursor. The squarified algorithm
 * lays a row along the shorter side of the remaining space and stops adding to
 * that row the moment the worst aspect ratio in it starts getting worse.
 *
 * Implemented here rather than pulled in: the algorithm is fifteen lines, and the
 * libraries that offer it also impose their own scales and colour choices.
 */

export type TreemapInput = { key: string; value: number };

export type Tile = {
  key: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type Rect = { x: number; y: number; width: number; height: number };

const worstRatio = (row: number[], length: number, scale: number): number => {
  const sum = row.reduce((a, b) => a + b, 0) * scale;
  if (sum <= 0 || length <= 0) return Infinity;
  const side = sum / length;
  let worst = 0;
  for (const v of row) {
    const scaled = v * scale;
    const other = scaled / side;
    worst = Math.max(worst, Math.max(side / other, other / side));
  }
  return worst;
};

/**
 * Lay values out inside a rectangle, largest first.
 *
 * Values are taken as given; zero and negative entries are dropped rather than
 * clamped, because a tile with no area is a tile that cannot be clicked.
 */
export function squarify(
  input: TreemapInput[],
  width: number,
  height: number,
  gap = 2,
): Tile[] {
  const items = input
    .filter((d) => Number.isFinite(d.value) && d.value > 0)
    .sort((a, b) => b.value - a.value);
  if (!items.length || width <= 0 || height <= 0) return [];

  const total = items.reduce((a, d) => a + d.value, 0);
  const scale = (width * height) / total;

  const tiles: Tile[] = [];
  let rect: Rect = { x: 0, y: 0, width, height };
  let cursor = 0;

  while (cursor < items.length) {
    const shortSide = Math.min(rect.width, rect.height);
    const row: number[] = [];
    let next = cursor;

    // Grow the row while it makes the worst tile in it rounder.
    while (next < items.length) {
      const candidate = [...row, items[next].value];
      if (
        row.length &&
        worstRatio(candidate, shortSide, scale) > worstRatio(row, shortSide, scale)
      ) {
        break;
      }
      row.push(items[next].value);
      next++;
    }

    const rowSum = row.reduce((a, b) => a + b, 0) * scale;
    const horizontal = rect.width >= rect.height;
    const thickness = rowSum / shortSide;

    let offset = horizontal ? rect.y : rect.x;
    for (let i = 0; i < row.length; i++) {
      const span = (row[i] * scale) / thickness;
      const item = items[cursor + i];
      tiles.push({
        key: item.key,
        value: item.value,
        x: horizontal ? rect.x : offset,
        y: horizontal ? offset : rect.y,
        width: horizontal ? thickness : span,
        height: horizontal ? span : thickness,
      });
      offset += span;
    }

    if (horizontal) {
      rect = {
        x: rect.x + thickness,
        y: rect.y,
        width: rect.width - thickness,
        height: rect.height,
      };
    } else {
      rect = {
        x: rect.x,
        y: rect.y + thickness,
        width: rect.width,
        height: rect.height - thickness,
      };
    }
    cursor = next;
  }

  // Grout: inset each tile so the ground shows between them. Never inset a tile
  // out of existence.
  if (gap > 0) {
    for (const t of tiles) {
      const dx = Math.min(gap / 2, t.width / 4);
      const dy = Math.min(gap / 2, t.height / 4);
      t.x += dx;
      t.y += dy;
      t.width -= dx * 2;
      t.height -= dy * 2;
    }
  }

  return tiles;
}

/**
 * Whether a tile is wide enough for a string, without measuring it.
 *
 * SVG text has no clipping box, so a ticker one pixel too long for its sheaf
 * renders straight across its neighbour. Both faces sit near 0.68em per uppercase
 * glyph and per tabular digit, which errs wide for lowercase: a label that passes
 * has room to spare.
 */
export function fitsTile(
  text: string,
  fontSize: number,
  tileWidth: number,
  inset: number,
): boolean {
  return tileWidth >= inset + text.length * fontSize * 0.68 + 4;
}

/** The whole string if it fits, else as much as fits with an ellipsis, else null. */
export function fitLabel(
  text: string,
  fontSize: number,
  tileWidth: number,
  inset: number,
): string | null {
  if (fitsTile(text, fontSize, tileWidth, inset)) return text;
  for (let keep = text.length - 1; keep >= 3; keep--) {
    const short = `${text.slice(0, keep)}…`;
    if (fitsTile(short, fontSize, tileWidth, inset)) return short;
  }
  return null;
}
