export function Faq({ items }: Readonly<{ items: { q: string; a: string }[] }>) {
  return (
    <div data-reveal className="divide-y divide-line rounded-xl border border-line bg-card">
      {items.map((item) => (
        <details key={item.q} className="group px-5 py-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-ink">
            {item.q}
            <span className="text-lg leading-none text-faint transition-transform duration-300 group-open:rotate-45" aria-hidden="true">
              +
            </span>
          </summary>
          <p className="mt-3 text-sm leading-relaxed text-body">{item.a}</p>
        </details>
      ))}
    </div>
  );
}
