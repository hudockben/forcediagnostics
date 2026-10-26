import Image from "next/image";

import lockup from "@/components/brand/logo-lockup.png";

// The forcediagnostics.ai logo: the F with its pulse line beside the name,
// cut from the brand artwork ("F Pulse Diagnostics Logo.png" at the repo
// root) with its black made transparent so it sits on any dark background.
// Its height comes from className (h-8 and so on); the width follows.
export function Wordmark({ className = "" }: { className?: string }) {
  return <Image src={lockup} alt="forcediagnostics.ai" loading="eager" className={`w-auto ${className}`} />;
}
