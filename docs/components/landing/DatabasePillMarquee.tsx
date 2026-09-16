import type { DatabaseSupportItem } from "@/data/databaseSupport";

const ROW_COUNT = 5;
const ROW_DIRECTIONS = ["left", "right", "left", "right", "left"];

export function DatabasePillMarquee({ items }: { items: DatabaseSupportItem[] }) {
  const perRow = Math.ceil(items.length / ROW_COUNT);
  const rows = Array.from({ length: ROW_COUNT }, (_, rowIndex) => items.slice(rowIndex * perRow, (rowIndex + 1) * perRow));

  return (
    <div className="landing-db-wall grid gap-3 py-1" aria-label="Supported databases">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="landing-db-marquee flex overflow-hidden" data-direction={ROW_DIRECTIONS[rowIndex]}>
          <div className="landing-db-track flex w-max min-w-full shrink-0 gap-3 px-[6px]">
            {[...row, ...row].map((db, index) => (
              <div aria-hidden={index >= row.length} className="landing-db-pill" key={`${db.id}-${index}`}>
                <img src={db.icon} alt="" width={20} height={20} loading="lazy" decoding="async" />
                <span>{db.name}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
