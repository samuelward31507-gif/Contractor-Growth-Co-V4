import { AgencySidebarContent } from "./agency-sidebar-content";

export function AgencySidebar({ userEmail, isAdmin }: { userEmail: string; isAdmin: boolean }) {
  return (
    <aside aria-label="Agency navigation" className="hidden w-60 shrink-0 border-r border-line bg-surface lg:flex">
      <AgencySidebarContent userEmail={userEmail} isAdmin={isAdmin} />
    </aside>
  );
}
