// Home's greeting. No server imports: it's worked out in the browser, from
// the viewer's own clock.

// From 4 in the morning, noon and 5 in the afternoon.
export function greetingFor(hour: number) {
  if (hour >= 4 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

// "Mike Tech" -> "Mike".
export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}
