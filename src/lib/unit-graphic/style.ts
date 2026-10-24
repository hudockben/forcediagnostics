import { FLAG_COLOURS, LINE_COLOURS, MUTED_COLOURS } from "@/lib/unit-3d/look";

// The unit graphic's styles, kept with the drawings (not in React code) so
// the tests can measure a whole drawing's markup. The drawing is the 3D
// unit's stand-in (while it loads, and where there's no WebGL) and is drawn
// in the same calm, service-manual manner on the same light plate: neutral
// grey line-work, the flagged systems filled flat (deep red high and
// confirmed, amber medium, a red outline only for low, grey ruled out)
// with a dark outline, numbered callouts. Nothing glows or moves.

// The line-work's ink.
export const INK = "#2b3036";

// Base line-work by class: f = face (tone, shade 0-3), l = line, t = tube
// (tp outline, ti its light core); tones b body, m seats, p parts, i
// inside, d detail, k rubber. Every outline but a tube's keeps one width at
// any size.
const shades = (tone: string, fills: number[], stroke: number, width: number) =>
  `${fills.map((_, i) => `.ug .f${tone}${i}`).join(",")}{fill:${INK};stroke:${INK};stroke-opacity:${stroke};stroke-width:${width}px}` +
  fills.map((fill, i) => `.ug .f${tone}${i}{fill-opacity:${String(fill).replace(/^0/, "")}}`).join("");

// A system's look sets --g (fill), --o (outline) and --w (outline width)
// for its paths and its callout. On a narrow card (a phone) the callouts
// are the numbered circles alone (.ug-c, drawn bigger), the key under the
// drawing naming them; elsewhere the full labels (.ug-f).
export const UNIT_GRAPHIC_CSS = `
.ug{font-family:var(--font-sans),ui-sans-serif,system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
.ug path{stroke-linejoin:round;stroke-linecap:round}
.ug path:not(.tp,.ti,.tc,.t),.ug .n{vector-effect:non-scaling-stroke}
${shades("b", [0.03, 0.05, 0.075, 0.1], 0.62, 1)}
${shades("m", [0.05, 0.075, 0.1, 0.13], 0.62, 1)}
${shades("p", [0.04, 0.06, 0.085, 0.11], 0.7, 1)}
${shades("i", [0.02, 0.035, 0.05, 0.07], 0.42, 0.9)}
.ug .fk{fill:#2a2d31;fill-opacity:.88;stroke:#16181b;stroke-opacity:.9;stroke-width:1px}
.ug .lb,.ug .lm,.ug .lp,.ug .li,.ug .ld,.ug .tp,.ug .ti{fill:none;stroke:${INK}}
.ug .lb{stroke-opacity:.5}.ug .lm{stroke-opacity:.6}.ug .lp{stroke-opacity:.66}.ug .li{stroke-opacity:.4;stroke-width:.9px}.ug .ld{stroke-opacity:.3;stroke-width:.7px}
.ug .tp{stroke-opacity:.82}.ug .ti{stroke-opacity:.45}.ug .tc{fill:none;stroke:#dfe2e5}
.ug [data-glow=high]{--g:${FLAG_COLOURS.high};--o:${LINE_COLOURS.flag};--w:1.4px}
.ug [data-glow=confirmed]{--g:${FLAG_COLOURS.confirmed};--o:${LINE_COLOURS.flag};--w:1.6px}
.ug [data-glow=medium]{--g:${FLAG_COLOURS.medium};--o:${LINE_COLOURS.flag};--w:1.4px}
.ug [data-glow=low]{--g:none;--o:${FLAG_COLOURS.low};--w:1.8px}
.ug [data-glow=ruled_out]{--g:${FLAG_COLOURS.ruledOut};--o:${LINE_COLOURS.flag};--w:1px}
.ug [data-glow=high][data-muted=true]{--g:${MUTED_COLOURS.high};--w:1px}
.ug [data-glow=medium][data-muted=true]{--g:${MUTED_COLOURS.medium};--w:1px}
.ug [data-glow=low][data-muted=true]{--o:${MUTED_COLOURS.low};--w:1.2px}
.ug-z{outline:none;cursor:pointer}
.ug-z .c{fill:none;stroke:var(--o);stroke-width:var(--w)}
.ug-z .c.f{fill:var(--g);fill-opacity:1}
.ug-z .c.t{stroke:var(--o)}
.ug-z[data-glow=low] .c.t,.ug-z[data-glow=low] .c.l{stroke:var(--o)}
.ug-z[data-active=true] .c,.ug-z:focus-visible .c{stroke:${LINE_COLOURS.active};stroke-width:2.4px}
.ug-ld{pointer-events:none}
.ug-ld path.l{fill:none;stroke:${LINE_COLOURS.edge};stroke-opacity:.85;stroke-width:1px}
.ug-ld [data-muted=true] path.l,.ug-ld path.l[data-muted=true]{stroke-opacity:.5}
.ug-ld .dot{fill:${LINE_COLOURS.edge}}
.ug-co{cursor:pointer}
.ug-co rect{fill:transparent}
.ug-co text{dominant-baseline:central;pointer-events:none}
.ug-co .name{font-weight:500;fill:#1f2328}
.ug-co .num{font-weight:600;text-anchor:middle}
.ug-co .ring{stroke-width:1.4px}
.ug-co .m{fill:#3a3f45}.ug-co .m0{fill:#3a3f45;fill-opacity:.2}
.ug-co[data-muted=true]{opacity:.7}
.ug-co[data-active=true] .ring,.ug-co[data-focus=true] .ring{stroke:${LINE_COLOURS.picked};stroke-width:2.4px}
.ug .ug-c{display:none}
@container (max-width: 450px){.ug .ug-f{display:none}.ug .ug-c{display:inline}}
`;
