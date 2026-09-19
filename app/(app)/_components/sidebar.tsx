import { SidebarContent } from "./sidebar-content";

export function Sidebar({
  organizationName,
  userEmail,
  role,
  showAgencyLink,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  showAgencyLink: boolean;
}) {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-slate-50 lg:flex">
      <SidebarContent organizationName={organizationName} userEmail={userEmail} role={role} showAgencyLink={showAgencyLink} />
    </aside>
  );
}
