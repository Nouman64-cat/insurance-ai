import CopilotRoleIcon from "./CopilotRoleIcon";

export default function CopilotBadge({ name, betaLabel }: { name: string; betaLabel: string }) {
  return <div title={name} className="flex h-11 min-w-0 max-w-[min(60vw,28rem)] items-center gap-2 rounded-xl bg-white ps-2 pe-3 ring-1 ring-zinc-200/80">
    <CopilotRoleIcon name={name} />
    <span className="truncate text-[15px] font-medium tracking-tight text-zinc-900">{name}</span>
    <span className="hidden shrink-0 rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-600 sm:inline-block">{betaLabel}</span>
  </div>;
}
