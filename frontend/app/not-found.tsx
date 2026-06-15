import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center">
        <span className="text-3xl text-slate-400">?</span>
      </div>
      <h2 className="text-2xl font-bold text-slate-800">Case not found</h2>
      <p className="text-slate-500 max-w-sm">
        The case you are looking for does not exist in this queue or has been archived.
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex items-center gap-2 px-4 py-2 bg-blue-700 text-white text-sm font-medium rounded-lg hover:bg-blue-800 transition-colors"
      >
        ← Return to Dashboard
      </Link>
    </div>
  );
}
