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
    <aside className="hidden w-64 shrink-0 border-r border-white/[0.06] bg-[#0a120f] lg:flex">
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
