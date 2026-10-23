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
