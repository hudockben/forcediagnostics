export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-6 px-6 py-32 sm:px-16">
        <p className="text-sm font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
          In development
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-black sm:text-5xl dark:text-zinc-50">
          Force Diagnostics
        </h1>
        <p className="max-w-xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Production rates and KPI diagnostics for construction crews.
        </p>
      </main>
    </div>
  );
}
