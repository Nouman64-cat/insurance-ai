import { Icon } from "@/components/ui/Icon";
import { lifecycle } from "@/content/home";
import { stagger } from "@/lib/utils";

export function Lifecycle() {
  return (
    <ol className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
      {lifecycle.map((stage, i) => (
        <li key={stage.title} data-reveal style={stagger(i)} className="glow bg-card p-5 2xl:p-6">
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/15 text-accent">
              <Icon name={stage.icon} />
            </span>
            <span className="text-xs font-semibold tabular-nums text-faint">0{i + 1}</span>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-ink">{stage.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-body">{stage.body}</p>
        </li>
      ))}
      <li className="hidden bg-alt p-5 sm:block 2xl:hidden" aria-hidden="true" />
    </ol>
  );
}
