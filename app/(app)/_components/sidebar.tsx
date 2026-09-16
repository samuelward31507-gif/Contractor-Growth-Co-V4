import { SidebarContent } from "./sidebar-content";

export function Sidebar({
  organizationName,
  userEmail,
  role,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
}) {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:flex">
      <SidebarContent organizationName={organizationName} userEmail={userEmail} role={role} />
    </aside>
  );
}
