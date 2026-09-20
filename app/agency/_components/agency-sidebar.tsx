import { AgencySidebarContent } from "./agency-sidebar-content";

export function AgencySidebar({ userEmail, isAdmin }: { userEmail: string; isAdmin: boolean }) {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-white/[0.06] bg-[#0a120f] lg:flex">
      <AgencySidebarContent userEmail={userEmail} isAdmin={isAdmin} />
    </aside>
  );
}
