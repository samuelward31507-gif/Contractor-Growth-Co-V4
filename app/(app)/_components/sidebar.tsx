import type { OrganizationVertical } from "@/lib/auth/organization";
import { SidebarContent } from "./sidebar-content";

export function Sidebar({
  organizationName,
  userEmail,
  role,
  vertical,
  showAgencyLink,
  initialCollapsed,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  vertical: OrganizationVertical;
  showAgencyLink: boolean;
  initialCollapsed: boolean | null;
}) {
  return (
    <aside aria-label="Primary" className="hidden shrink-0 border-r border-line bg-sidebar lg:flex">
      <SidebarContent
        organizationName={organizationName}
        userEmail={userEmail}
        role={role}
        vertical={vertical}
        showAgencyLink={showAgencyLink}
        initialCollapsed={initialCollapsed}
      />
    </aside>
  );
}
