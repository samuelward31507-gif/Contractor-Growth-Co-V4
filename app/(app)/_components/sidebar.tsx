import type { OrganizationVertical } from "@/lib/auth/organization";
import { SidebarContent } from "./sidebar-content";

export function Sidebar({
  organizationName,
  userEmail,
  role,
  vertical,
  showAgencyLink,
}: {
  organizationName: string;
  userEmail: string;
  role: string;
  vertical: OrganizationVertical;
  showAgencyLink: boolean;
}) {
  return (
    <aside aria-label="Primary" className="hidden shrink-0 border-r border-line bg-surface lg:flex">
      <SidebarContent
        organizationName={organizationName}
        userEmail={userEmail}
        role={role}
        vertical={vertical}
        showAgencyLink={showAgencyLink}
      />
    </aside>
  );
}
