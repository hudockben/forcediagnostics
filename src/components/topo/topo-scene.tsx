import {
  MAP_H,
  MAP_W,
  RIDGE_H,
  RIDGE_W,
  contours,
  ridge,
  smoothPath,
} from "./geometry";

const CONTOURS = contours();
const FAR_RIDGE = ridge({
  seed: 7,
  base: 178,
  amplitude: 36,
  treeMin: 16,
  treeMax: 42,
  spacing: 13,
});
const NEAR_RIDGE = ridge({
  seed: 3,
  base: 266,
  amplitude: 28,
  treeMin: 36,
  treeMax: 100,
  spacing: 21,
});

const TRAIL: [number, number][] = [
  [70, 780],
  [180, 700],
  [250, 610],
  [370, 560],
  [460, 470],
  [500, 360],
  [620, 250],
  [780, 190],
  [930, 160],
  [1080, 230],
  [1200, 330],
  [1330, 300],
  [1430, 210],
];
const TRAIL_PATH = smoothPath(TRAIL);
const WAYPOINTS = [3, 5, 8, 10, 12];

const mapBox = "absolute -left-[4%] -top-[4%] h-[108%] w-[108%]";

// Background for the sign-in screens: drifting contour lines and a GPS trail
// over a pine ridgeline. Decorative only, and still when reduced motion is on.
export function TopoScene() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden"
    >
      <div className="topo-sky absolute inset-0" />

      <svg
        className={`topo-drift ${mapBox}`}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          {CONTOURS.map((contour, i) =>
            contour.index ? (
              <g key={i} className="stroke-glow">
                <path
                  d={contour.d}
                  strokeWidth={6}
                  strokeOpacity={0.07}
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={contour.d}
                  strokeWidth={1.4}
                  strokeOpacity={0.42}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ) : (
              <path
                key={i}
                d={contour.d}
                className="stroke-glow"
                strokeWidth={1}
                strokeOpacity={0.17}
                vectorEffect="non-scaling-stroke"
              />
            ),
          )}
        </g>
      </svg>

      <svg
        className={`topo-drift ${mapBox}`}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <path
          d={TRAIL_PATH}
          fill="none"
          className="stroke-trail"
          strokeWidth={7}
          strokeOpacity={0.14}
          strokeLinecap="round"
        />
        <path
          d={TRAIL_PATH}
          fill="none"
          className="topo-trail stroke-trail"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="0.1 11.9"
        />
        {WAYPOINTS.map((index, n) => {
          const [x, y] = TRAIL[index];
          const current = n === WAYPOINTS.length - 1;
          return (
            <g key={index} transform={`translate(${x} ${y})`}>
              <circle
                r={current ? 22 : 15}
                fill="none"
                className="topo-ping stroke-trail"
                strokeWidth={1.5}
                style={{ animationDelay: `${n * 0.55}s` }}
              />
              {current && (
                <circle
                  r={11}
                  fill="none"
                  className="stroke-trail"
                  strokeWidth={1.5}
                  strokeOpacity={0.7}
                />
              )}
              <circle r={current ? 5 : 4} className="fill-trail" />
              <text
                x={current ? 18 : 12}
                y={current ? -16 : -12}
                className="fill-trail stroke-forest-950 font-mono text-[13px] tracking-widest [paint-order:stroke]"
                fillOpacity={0.9}
                strokeWidth={4}
              >
                WP {String(n + 1).padStart(2, "0")}
              </text>
            </g>
          );
        })}
      </svg>

      <svg
        className="absolute inset-x-0 bottom-0 h-auto max-h-[42vh] min-h-[26vh] w-full"
        viewBox={`0 0 ${RIDGE_W} ${RIDGE_H}`}
        preserveAspectRatio="xMidYMax slice"
      >
        <defs>
          <linearGradient id="ridge-horizon" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--color-glow)" stopOpacity={0} />
            <stop offset="0.6" stopColor="var(--color-glow)" stopOpacity={0.13} />
          </linearGradient>
          <linearGradient id="ridge-mist" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--color-forest-950)" stopOpacity={0} />
            <stop offset="1" stopColor="var(--color-forest-950)" stopOpacity={0.9} />
          </linearGradient>
        </defs>
        <rect width={RIDGE_W} height={RIDGE_H} fill="url(#ridge-horizon)" />
        <path d={FAR_RIDGE.fill} className="fill-forest-800" />
        <path
          d={FAR_RIDGE.crest}
          fill="none"
          className="stroke-glow"
          strokeOpacity={0.35}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <rect y={150} width={RIDGE_W} height={RIDGE_H - 150} fill="url(#ridge-mist)" />
        <path d={NEAR_RIDGE.fill} className="fill-black" />
      </svg>

      <div className="topo-vignette absolute inset-0" />
    </div>
  );
}
