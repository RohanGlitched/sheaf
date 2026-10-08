/** Placeholders shaped like what is loading, so the page does not jump when it lands. */

function Bar({ className }: { className: string }) {
  return <span className={`skeleton block ${className}`} />;
}

export function MosaicSkeleton({ height, label }: { height: number; label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      style={{ height }}
      className="grid grid-cols-[2fr_1.3fr_1fr] grid-rows-[1.4fr_1fr] gap-1 border border-line bg-surface p-1"
    >
      <Bar className="row-span-2 h-full" />
      <Bar className="h-full" />
      <Bar className="h-full" />
      <Bar className="h-full" />
      <Bar className="h-full" />
    </div>
  );
}

export function CardSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-label="Reading the program"
      className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="border border-line bg-surface">
          <div className="flex justify-between gap-4 px-5 pt-5">
            <div className="flex-1">
              <Bar className="h-5 w-2/3" />
              <Bar className="mt-2 h-3 w-1/2" />
            </div>
            <Bar className="h-5 w-16" />
          </div>
          <div className="mt-4 px-5">
            <Bar className="h-[132px]" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line px-5 py-4">
            <Bar className="h-7" />
            <Bar className="h-7" />
            <Bar className="h-7" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function BasketSkeleton() {
  return (
    <div
      role="status"
      aria-label="Reading the basket"
      className="grid gap-12 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
    >
      <div>
        <div className="flex justify-between gap-6">
          <div className="flex-1">
            <Bar className="h-16 w-3/4" />
            <Bar className="mt-4 h-3 w-1/3" />
          </div>
          <Bar className="h-12 w-36" />
        </div>
        <Bar className="mt-8 h-4 w-full" />
        <Bar className="mt-2 h-4 w-2/3" />
        <Bar className="mt-8 h-[260px]" />
        <div className="mt-6 grid grid-cols-2 gap-px sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Bar key={i} className="h-24" />
          ))}
        </div>
      </div>
      <Bar className="h-[440px]" />
    </div>
  );
}
