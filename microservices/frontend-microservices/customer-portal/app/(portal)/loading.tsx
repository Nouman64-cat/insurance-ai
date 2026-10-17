import { Skeleton } from "@/components/ui";
export default function Loading() {
  return <div className="space-y-4" aria-busy="true"><Skeleton className="h-7 w-48" /><div className="grid grid-cols-2 lg:grid-cols-4 gap-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div><Skeleton className="h-64" /></div>;
}
