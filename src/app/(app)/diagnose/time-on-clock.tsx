import { formatDuration } from "@/lib/diagnose-clock-rules";

import { QuickIcon } from "./icons";

// The time on a diagnosis's clock in a list's line of details (Diagnose's
// list, Home's, a customer's vehicle's diagnoses): the stopwatch mark and
// "52 min".
export function TimeOnClock({ seconds }: { seconds: number }) {
  return (
    <span data-row-clock className="whitespace-nowrap">
      <QuickIcon className="mr-0.5 inline size-3.5 align-[-2px]" />
      {formatDuration(seconds)}
      <span className="sr-only"> on the clock</span>
    </span>
  );
}
