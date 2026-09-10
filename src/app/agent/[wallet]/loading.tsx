import { Skeleton } from '@/components/ui/skeleton';

/**
 * Navigation fallback for /agent/[wallet].
 *
 * Shaped like the profile SHELL (back link · avatar · name+address · score
 * ring), not like the whole page — the shell renders from the `wallets` row
 * with no awaits, so this is on screen only for the RSC round-trip and is
 * replaced by real identity, not by more placeholders. The on-chain sections
 * below it carry their own in-place card skeletons.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-40" />
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <Skeleton className="size-16 rounded-full" />
          <div className="space-y-3">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-80" />
          </div>
        </div>
        <Skeleton className="size-[90px] rounded-full" />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
