import type { ReactNode } from "react";

export type IconName =
  | "dashboard"
  | "leads"
  | "contacts"
  | "appointments"
  | "conversations"
  | "estimates"
  | "jobs"
  | "activity"
  | "settings"
  | "menu"
  | "close"
  | "logout"
  | "flame"
  | "clock"
  | "document"
  | "search"
  | "plus"
  | "pencil"
  | "trash"
  | "arrow-left";

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3.75" y="3.75" width="7" height="7" rx="1.5" />
      <rect x="13.25" y="3.75" width="7" height="7" rx="1.5" />
      <rect x="3.75" y="13.25" width="7" height="7" rx="1.5" />
      <rect x="13.25" y="13.25" width="7" height="7" rx="1.5" />
    </>
  ),
  leads: (
    <>
      <path d="M3.75 4.75h16.5" />
      <path d="M6.75 9.75h10.5" />
      <path d="M9.75 14.75h4.5" />
      <path d="M11.25 19.25h1.5" />
    </>
  ),
  contacts: (
    <>
      <circle cx="12" cy="8.25" r="3" />
      <path d="M5.75 19.25c0-3.45 2.8-6 6.25-6s6.25 2.55 6.25 6" />
    </>
  ),
  appointments: (
    <>
      <rect x="3.75" y="5.25" width="16.5" height="14.5" rx="2" />
      <path d="M8 3.5v3.5" />
      <path d="M16 3.5v3.5" />
      <path d="M3.75 9.75h16.5" />
    </>
  ),
  conversations: (
    <path d="M4.75 5.75h14.5a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H10l-4.25 3.5v-3.5H4.75a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1Z" />
  ),
  estimates: (
    <>
      <path d="M6.75 3.75h7.5l4 4v12.5a1 1 0 0 1-1 1H6.75a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z" />
      <path d="M14.25 3.75v4h4" />
      <path d="M8.75 12.75h6.5" />
      <path d="M8.75 16.25h6.5" />
    </>
  ),
  jobs: (
    <>
      <rect x="3.75" y="7.75" width="16.5" height="11.5" rx="2" />
      <path d="M8.75 7.75V6a2 2 0 0 1 2-2h2.5a2 2 0 0 1 2 2v1.75" />
      <path d="M3.75 12.75h16.5" />
    </>
  ),
  activity: <path d="M3.75 12.75h3.5l2-6 4 12 2-9 1.5 3h3.5" />,
  settings: (
    <>
      <path d="M4.75 7.75h8.5" />
      <path d="M17.25 7.75h1.5" />
      <circle cx="15.25" cy="7.75" r="1.75" />
      <path d="M4.75 16.25h1.5" />
      <path d="M10.25 16.25h8.5" />
      <circle cx="8.25" cy="16.25" r="1.75" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6.75h16" />
      <path d="M4 12h16" />
      <path d="M4 17.25h16" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  logout: (
    <>
      <path d="M14.25 8.25V6.5a1.75 1.75 0 0 0-1.75-1.75H6.75A1.75 1.75 0 0 0 5 6.5v11a1.75 1.75 0 0 0 1.75 1.75h5.75a1.75 1.75 0 0 0 1.75-1.75v-1.75" />
      <path d="M9.75 12h10" />
      <path d="M16.75 8.5l3.5 3.5-3.5 3.5" />
    </>
  ),
  flame: (
    <path d="M12 3.5c1 2 3.5 3.5 3.5 6.75a3.5 3.5 0 1 1-7 0c0-1 .35-1.75.85-2.5.2 1 .9 1.5 1.4 1.25-.5-2 .4-3.75 1.25-5.5Z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.25l3 1.75" />
    </>
  ),
  document: (
    <>
      <path d="M7.5 3.75h6l4 4v12.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z" />
      <path d="M13.5 3.75v4h4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.75" cy="10.75" r="6.25" />
      <path d="M19.25 19.25l-4.3-4.3" />
    </>
  ),
  plus: (
    <>
      <path d="M12 4.75v14.5" />
      <path d="M4.75 12h14.5" />
    </>
  ),
  pencil: (
    <>
      <path d="M15.25 4.75l4 4-11 11-4.5 1 1-4.5 10.5-11.5Z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M5.75 7.75h12.5" />
      <path d="M9.75 7.75V6a1.5 1.5 0 0 1 1.5-1.5h1.5A1.5 1.5 0 0 1 14.25 6v1.75" />
      <path d="M7.5 7.75l.75 11a1.5 1.5 0 0 0 1.5 1.4h4.5a1.5 1.5 0 0 0 1.5-1.4l.75-11" />
      <path d="M10.5 11.25v6" />
      <path d="M13.5 11.25v6" />
    </>
  ),
  "arrow-left": (
    <>
      <path d="M19.25 12H4.75" />
      <path d="M10.5 6.25L4.75 12l5.75 5.75" />
    </>
  ),
};

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
