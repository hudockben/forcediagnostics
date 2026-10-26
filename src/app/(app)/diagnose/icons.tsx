import type { ReactNode } from "react";

// Diagnose's small line icons, drawn inline (16-unit grid, currentColor).
// Decorative: whatever they stand for is also said in text or a label.

function Icon({ children, className = "size-4" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

type Props = { className?: string };

export const SearchIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.6 3.6" />
  </Icon>
);

export const PageIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 1.75h5.25l2.75 2.75v9.75H4z" />
    <path d="M9.25 1.75V4.5H12M6 8h4M6 10.5h4" />
  </Icon>
);

export const GlobeIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c-3.2 3.5-3.2 9 0 12.5M8 1.75c3.2 3.5 3.2 9 0 12.5" />
  </Icon>
);

export const BookIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M8 4c-1.6-1.2-3.6-1.5-6-1v10c2.4-.5 4.4-.2 6 1 1.6-1.2 3.6-1.5 6-1V3c-2.4-.5-4.4-.2-6 1zM8 4v10" />
  </Icon>
);

export const BulbIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M5.75 11.25c0-1.7-2-2.6-2-5.1a4.25 4.25 0 0 1 8.5 0c0 2.5-2 3.4-2 5.1zM6.25 13.75h3.5" />
  </Icon>
);

export const WarningIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M8 1.75 14.75 13.5H1.25z" />
    <path d="M8 6.25v3.25M8 11.6v.05" />
  </Icon>
);

export const CheckIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m3 8.5 3.25 3.25L13 5" />
  </Icon>
);

export const CrossIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const OpenIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="4.5" strokeDasharray="2.4 1.8" />
  </Icon>
);

export const CausesIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.75V4M8 12v2.25M1.75 8H4M12 8h2.25" />
  </Icon>
);

export const ChecksIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2.5 3.5h1.5M2.5 8h1.5M2.5 12.5h1.5M6.5 3.5h7M6.5 8h7M6.5 12.5h7" />
  </Icon>
);

export const UnitIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M8 1.75 14 5v6l-6 3.25L2 11V5z" />
    <path d="M2 5l6 3.25L14 5M8 8.25v6" />
  </Icon>
);

export const ChatIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2.25 3.25h11.5v7.5H7l-3.25 2.75v-2.75h-1.5z" />
  </Icon>
);

export const ReplyIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M6 3.75 2.25 7.5 6 11.25" />
    <path d="M2.25 7.5h6.5a5 5 0 0 1 5 5v.75" />
  </Icon>
);

export const ChevronIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </Icon>
);

export const ExpandIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M9.5 2.25h4.25V6.5M6.5 13.75H2.25V9.5M13.75 2.25 9 7M2.25 13.75 7 9" />
  </Icon>
);

// Solid: the body as it is (a filled block); phantom: the body as an
// outline with the part inside showing.
export const SolidIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2.25 9.5 4 5.75h8L13.75 9.5v2.75H2.25z" fill="currentColor" fillOpacity={0.35} />
    <circle cx="4.75" cy="12.25" r="1.25" />
    <circle cx="11.25" cy="12.25" r="1.25" />
  </Icon>
);

export const PhantomIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2.25 9.5 4 5.75h8L13.75 9.5v2.75H2.25z" strokeDasharray="1.6 1.4" />
    <rect x="6.5" y="7.75" width="3" height="2.25" rx=".5" fill="currentColor" />
    <circle cx="4.75" cy="12.25" r="1.25" />
    <circle cx="11.25" cy="12.25" r="1.25" />
  </Icon>
);

// Claude at work: a still mark (nothing on the Diagnose screen pulses or
// spins); the step's words say what it's doing.
export const WorkingIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.75" strokeOpacity={0.35} />
    <path d="M8 2.25a5.75 5.75 0 0 1 5.75 5.75" />
    <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const ResetIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M3 8a5 5 0 1 0 1.6-3.7" />
    <path d="M2.75 2.5v2.75H5.5" />
  </Icon>
);

export const BackIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M10 3 5 8l5 5" />
  </Icon>
);

export const ZoomInIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.6 3.6M5 7h4M7 5v4" />
  </Icon>
);

export const ZoomOutIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.6 3.6M5 7h4" />
  </Icon>
);

// How much work a check is: a quick look, a test with a meter, teardown.
export const QuickIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="9" r="5.25" />
    <path d="M8 9V6.25M6.5 1.75h3M12.4 4.6l.9-.9" />
  </Icon>
);

export const MeterIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M2.25 11.5a5.75 5.75 0 0 1 11.5 0" />
    <path d="M8 11.5 10.75 7M2.25 13.75h11.5" />
  </Icon>
);

export const WrenchIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M10.6 2.1a3.4 3.4 0 0 0-3.9 4.5L2.3 11a1.5 1.5 0 0 0 2.1 2.1l4.4-4.4a3.4 3.4 0 0 0 4.5-3.9l-2 2-1.9-.4-.4-1.9z" />
  </Icon>
);

// The tech, beside their name on their messages.
export const PersonIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="5.25" r="2.75" />
    <path d="M2.75 14c.4-2.9 2.6-4.75 5.25-4.75s4.85 1.85 5.25 4.75" />
  </Icon>
);

// A note that only informs (part of a VIN kept as it was typed).
export const InfoIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.25V11M8 5h.01" />
  </Icon>
);
