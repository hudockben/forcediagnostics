import { LoginCard } from "@/components/login-card";
import { TopoScene } from "@/components/topo/topo-scene";
import { Wordmark } from "@/components/wordmark";

const hudText = "font-mono text-[11px] tracking-[0.2em] uppercase";

export default function Home() {
  return (
    <>
      <TopoScene />
      <div className="relative flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 px-4 py-5 sm:px-8">
          <Wordmark className="text-xl sm:text-2xl" />
          <p className={`flex items-center gap-2 text-glow ${hudText}`}>
            <span className="hud-pulse size-2 rounded-full bg-glow shadow-[0_0_10px] shadow-glow" />
            System online
          </p>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-8">
          <LoginCard />
        </main>

        <footer
          aria-hidden
          className={`flex items-end justify-between gap-4 px-4 pb-5 text-glow/70 sm:px-8 ${hudText}`}
        >
          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1">
            <dt className="text-glow/45">Lat</dt>
            <dd>N 44°58.402′</dd>
            <dt className="text-glow/45">Lon</dt>
            <dd>W 110°41.317′</dd>
            <dt className="text-glow/45">Elev</dt>
            <dd>2,214 m</dd>
          </dl>
          <div className="hidden flex-col items-end gap-2 sm:flex">
            <span className="flex h-2 w-28 border-x border-b border-glow/50" />
            <span>Contour interval 20 m</span>
          </div>
        </footer>
      </div>
    </>
  );
}
