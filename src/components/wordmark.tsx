export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`tracking-tight lowercase ${className}`}>
      <span className="font-semibold text-ink">force</span>
      <span className="font-light text-ink-muted">diagnostics</span>
      <span className="font-semibold text-glow">.ai</span>
    </span>
  );
}
