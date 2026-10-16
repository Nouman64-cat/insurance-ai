import { Icon } from "@/components/ui/Icon";
import { lifecycle } from "@/content/home";
import { stagger } from "@/lib/utils";

// The seven policy stages.
//  - below lg: a vertical timeline, nodes joined by gradient segments with the card beside each
//  - lg: centred rows of four (the second row of three sits in the middle, no filler tile)
//  - xl and up: one horizontal timeline of seven, nodes on a line above the cards
export function Lifecycle() {
  return (
    <ol className="relative flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:justify-center xl:flex-nowrap xl:gap-3 2xl:gap-4">
      {/* Horizontal line from the first node centre to the last one */}
      <span
        aria-hidden="true"
        className="absolute left-5 right-[calc((100%-4.5rem)/7-1.25rem)] top-5 hidden h-px bg-gradient-to-r from-brand-cyan/60 via-brand/50 to-brand-violet/60 xl:block 2xl:right-[calc((100%-6rem)/7-1.25rem)]"
      />
      {lifecycle.map((stage, i) => (
        <li
          key={stage.title}
          data-reveal
          style={stagger(i)}
          className="relative grid grid-cols-[2.5rem_minmax(0,1fr)] gap-4 lg:flex lg:w-[calc((100%-3rem)/4)] lg:flex-col lg:gap-4 xl:w-auto xl:min-w-0 xl:flex-1 xl:basis-0"
        >
          {/* Below lg: a segment from this node down to the next one (the list gap is 1rem) */}
          {i < lifecycle.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute -bottom-4 left-5 top-10 w-px bg-gradient-to-b from-brand-cyan/50 to-brand-violet/50 lg:hidden"
            />
          )}
          <span className="relative flex h-10 w-10 items-center justify-center rounded-full border border-line bg-card text-accent shadow-card">
            <Icon name={stage.icon} className="h-[1.125rem] w-[1.125rem]" />
          </span>
          <div className="glass glass-hover glow rounded-2xl p-5 lg:flex-1 xl:p-4 2xl:p-5">
            <p className="text-xs font-semibold tabular-nums text-faint">0{i + 1}</p>
            <h3 className="mt-1 text-sm font-semibold text-ink 2xl:text-base">{stage.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-body xl:text-[0.8125rem] 2xl:text-sm">{stage.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
