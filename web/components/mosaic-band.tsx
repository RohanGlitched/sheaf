/**
 * A running key, laid in stone: the meander border that frames a Byzantine floor,
 * built from 4px sheaves with a grout line between them. Gold stones trace the
 * key; the ground between them is set in dark lapis, so the band is a floor, not
 * a line drawing. It marks the seams between sections the way a border marks the
 * edge of a mosaic.
 */
const KEY = [
  "XXXXXXXX",
  ".......X",
  ".XXXX..X",
  ".X..X..X",
  ".X..XXXX",
  ".X......",
  "XXXXXXXX",
];
const CELL = 5;
const STONE = 4;
const W = KEY[0].length * CELL;
const H = KEY.length * CELL;

/** A quiet, deterministic shimmer so no two stones are quite the same cut. */
const shade = (x: number, y: number) => 0.8 + (((x * 7 + y * 13) % 5) / 5) * 0.2;

export function MosaicBand({ className = "" }: { className?: string }) {
  return (
    <svg className={`block w-full ${className}`} height={H} aria-hidden focusable="false">
      <defs>
        <pattern id="sheaf-key" width={W} height={H} patternUnits="userSpaceOnUse">
          {KEY.flatMap((row, y) =>
            [...row].map((c, x) => (
              <rect
                key={`${x}-${y}`}
                x={x * CELL}
                y={y * CELL}
                width={STONE}
                height={STONE}
                fill={c === "X" ? "var(--color-bind)" : "var(--color-sunk)"}
                opacity={c === "X" ? shade(x, y) : 0.9}
              />
            )),
          )}
        </pattern>
      </defs>
      <rect width="100%" height={H} fill="url(#sheaf-key)" />
    </svg>
  );
}
