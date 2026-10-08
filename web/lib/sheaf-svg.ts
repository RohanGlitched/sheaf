import { SHEAF_BOX, earSeeds, sheafLayout, type Stalk } from "@/components/sheaf-mark";

/**
 * The Sheaf mark as a standalone SVG data URI, for share images rendered on the
 * server. Same geometry as the component, written out as a string because share
 * images cannot render React components into SVG markup.
 */
export function sheafDataUri(stalks: Stalk[], band = "#3438c9"): string {
  const { W, H, CX, CY } = SHEAF_BOX;
  const placed = sheafLayout(stalks);
  const parts: string[] = [];
  for (const { s, tip, foot, ctrl, ux, uy } of placed) {
    parts.push(
      `<path d="M ${foot.x} ${foot.y} L ${CX} ${CY} Q ${ctrl.x} ${ctrl.y} ${tip.x} ${tip.y}" fill="none" stroke="${s.color}" stroke-opacity="0.78" stroke-width="6" stroke-linecap="round"/>`,
    );
    for (const g of earSeeds(tip.x, tip.y, ux, uy, 1.3)) {
      parts.push(`<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}" transform="rotate(${g.rot} ${g.cx} ${g.cy})" fill="${s.color}"/>`);
    }
  }
  const bandW = 34 + Math.min(placed.length, 8) * 9;
  parts.push(`<rect x="${CX - bandW / 2}" y="${CY - 13}" width="${bandW}" height="26" rx="8" fill="${band}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
