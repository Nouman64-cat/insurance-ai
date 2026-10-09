// Shown instantly inside the dashboard shell while the next page loads. Having a
// loading boundary also lets Next prefetch up to this point for every <Link>,
// so clicks swap content immediately instead of waiting on the server.
export default function Loading() {
  return (
    <div className="animate-pulse space-y-6 p-6" role="status" aria-label="Loading page">
      <div className="space-y-2">
        <div className="h-6 w-56 rounded-md bg-slate-200" />
        <div className="h-4 w-80 max-w-full rounded-md bg-slate-200/70" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-slate-200 bg-white" />
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-4 rounded-md bg-slate-200/70" style={{ width: `${90 - (i % 3) * 15}%` }} />
        ))}
      </div>
    </div>
  );
}
