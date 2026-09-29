import { SkeletonPage, SkeletonPageHeader, SkeletonRows } from "@/lib/ui/skeleton";

/**
 * Performance Pass A: SMS settings' loading state. Without it this page
 * would fall back to app/(app)/settings/loading.tsx (the main Settings form
 * skeleton), which is the wrong shape. Header plus card. No data, no text.
 */
export default function SmsSettingsLoading() {
  return (
    <SkeletonPage gap="gap-6" width="content">
      <SkeletonPageHeader />
      <SkeletonRows count={4} leading={false} />
    </SkeletonPage>
  );
}
