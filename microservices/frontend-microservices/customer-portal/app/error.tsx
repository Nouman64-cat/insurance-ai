"use client";
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center"><p className="text-sm text-slate-600">Something went wrong. Please try again.</p>
        <button onClick={reset} className="btn-primary mt-4">Try again</button></div>
    </div>
  );
}
