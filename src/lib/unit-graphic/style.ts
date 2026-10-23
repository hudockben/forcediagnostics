// The unit graphic's styles, kept with the drawings (not in React code) so
// the tests can measure a whole drawing's markup.

export const TEAL = "#3fe0c5";

// Base line-work by class: f = face (tone, shade 0-3), l = line, t = tube
// (tp outline, ti its dark core); tones b body, m seats, p parts, d detail,
// k rubber. Every outline but a tube's keeps one width at any size.
const shades = (tone: string, fills: number[], stroke: number, width: number) =>
  `${fills.map((_, i) => `.ug .f${tone}${i}`).join(",")}{fill:${TEAL};stroke:${TEAL};stroke-opacity:${stroke};stroke-width:${width}px}` +
  fills.map((fill, i) => `.ug .f${tone}${i}{fill-opacity:${String(fill).replace(/^0/, "")}}`).join("");

// A system's glow sets --g (colour), --w (outline width) and --a (dashes)
// for its paths, its leader and its label.
// Likelihood shows in shape as well as colour: high is a solid fill (with
// a pulsing halo), medium is hatched (--hatch, set on the drawing), low an
// outline only, dashed; each label carries the same three-bar meter as the
// causes list. Confirmed is solid with a white outline and a check; once a
// cause is confirmed the others are muted (outline only, no glow).
export const UNIT_GRAPHIC_CSS = `
.ug{font-family:var(--font-sans),ui-sans-serif,system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
.ug path{stroke-linejoin:round;stroke-linecap:round}
.ug path:not(.tp,.ti,.tc,.t),.ug .n{vector-effect:non-scaling-stroke}
${shades("b", [0.03, 0.05, 0.075, 0.1], 0.58, 1)}
${shades("m", [0.04, 0.06, 0.085, 0.11], 0.62, 1)}
${shades("p", [0.035, 0.055, 0.08, 0.11], 0.75, 1)}
${shades("i", [0.025, 0.04, 0.06, 0.08], 0.45, 0.9)}
.ug .fk{fill:#050d0a;fill-opacity:.92;stroke:${TEAL};stroke-opacity:.85;stroke-width:1.1px}
.ug .lb,.ug .lm,.ug .lp,.ug .li,.ug .ld,.ug .tp,.ug .ti{fill:none;stroke:${TEAL}}
.ug .lb{stroke-opacity:.42}.ug .lm{stroke-opacity:.6}.ug .lp{stroke-opacity:.7}.ug .li{stroke-opacity:.45;stroke-width:.9px}.ug .ld{stroke-opacity:.3;stroke-width:.7px}
.ug .tp{stroke-opacity:.9}.ug .ti{stroke-opacity:.5}.ug .tc{fill:none;stroke:#0a1714}
.ug [data-glow=high]{--g:#ff4d55;--w:1.8px}
.ug [data-glow=medium]{--g:#ff8a4c;--w:1.4px}
.ug [data-glow=low]{--g:#ff6b70;--w:1.2px;--a:4 2.5}
.ug [data-glow=confirmed]{--g:#ff6b70;--w:1.6px}
.ug [data-glow=ruled_out]{--g:#8ea49a;--w:1px;--a:2 2.5}
.ug-z{outline:none;cursor:pointer}
.ug-z .c{fill:none;stroke:var(--g);stroke-width:var(--w);stroke-dasharray:var(--a,none)}
.ug-z[data-glow=high] .c.f{fill:var(--g);fill-opacity:.36}
.ug-z[data-glow=medium] .c.f{fill:var(--hatch,#ff8a4c33)}
.ug-z[data-glow=confirmed] .c{stroke:#fff}
.ug-z[data-glow=confirmed] .c.f{fill:#e5484d;fill-opacity:.7}
.ug-z[data-glow=ruled_out] .c.f{fill:#05100c;fill-opacity:.55}
.ug-z[data-muted=true] .c{stroke-opacity:.55}
.ug-z[data-muted=true] .c.f{fill:none}
.ug-z .c.t{stroke-dasharray:none}
.ug-z[data-active=true] .c{stroke:#fff;stroke-opacity:1;stroke-width:2.6px}
.ug-z:focus-visible .c{stroke:#fff;stroke-opacity:1;stroke-width:2.6px}
.ug-ld{pointer-events:none}
.ug-ld path.l{fill:none;stroke:var(--g);stroke-opacity:.85;stroke-width:1px}
.ug-ld [data-glow=low] path.l,.ug-ld [data-muted=true] path.l{stroke-opacity:.55}
.ug-co{cursor:pointer}
.ug-co .p{fill:#0a1512;stroke:var(--g);stroke-width:1.2px;stroke-dasharray:var(--a,none);vector-effect:non-scaling-stroke}
.ug-co[data-glow=high] .p{fill:#2c0a0e;stroke-width:2px}
.ug-co[data-glow=confirmed] .p{fill:#d93a40;stroke:#fff;stroke-width:1.4px}
.ug-co text{font-weight:600;dominant-baseline:central;fill:#ffd0d2;pointer-events:none}
.ug-co[data-glow=confirmed] text{fill:#fff}
.ug-co[data-glow=ruled_out] text{fill:#8ea49a;text-decoration:line-through}
.ug-co .m{fill:var(--g)}.ug-co .m0{fill:#fff;fill-opacity:.2}
.ug-co[data-muted=true]{opacity:.6}
.ug-co[data-active=true] .p,.ug-co[data-focus=true] .p{stroke:#fff;stroke-width:2.4px;stroke-dasharray:none}
@media (prefers-reduced-motion:no-preference){.ug-z[data-glow=high] .h{animation:ug-pulse 1.9s ease-in-out infinite}}
@keyframes ug-pulse{50%{opacity:.55}}
`;
