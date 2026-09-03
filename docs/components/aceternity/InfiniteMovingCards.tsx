type Testimonial = {
  name: string;
  role: string;
  quote: string;
  avatar: string;
};

type InfiniteMovingCardsProps = {
  items: Testimonial[];
  direction?: "left" | "right";
  speed?: "slow" | "normal";
};

// 滚动一圈位移为半个 track（items.length × 卡片步距），
// 按目标线速度反推 duration，保证不同条数的行视觉速度一致。
// 36px/s 与首页数据库 pill 墙的最快行实测流速对齐。
// track 必须 shrink-0，否则作为 flex 子项会被压回容器宽度，
// -50% 位移随之下缩，实际线速度会远低于目标值。
const CARD_PITCH_PX = 354; // 340px 卡片 + 14px 间距
const SCROLL_SPEED_PX_PER_S = 36;

export function InfiniteMovingCards({ items, direction = "left", speed = "normal" }: InfiniteMovingCardsProps) {
  const repeatedItems = [...items, ...items];
  const durationSeconds = (items.length * CARD_PITCH_PX) / SCROLL_SPEED_PX_PER_S;

  return (
    <div className="landing-testimonial-marquee flex overflow-hidden" data-direction={direction} data-speed={speed} aria-label="Testimonials" tabIndex={0}>
      <div
        className="landing-testimonial-track flex w-max min-w-full shrink-0 gap-3.5 px-[7px]"
        style={{ "--testimonial-duration": `${durationSeconds}s` } as React.CSSProperties}
      >
        {repeatedItems.map((item, index) => (
          <figure aria-hidden={index >= items.length} className="landing-testimonial-card flex-[0_0_340px] min-h-[188px] rounded-[9px] m-0 p-[22px] max-[760px]:flex-[0_0_286px] max-[760px]:min-h-[210px] max-[760px]:p-[18px]" key={`${item.name}-${index}`}>
            <div className="flex gap-3 items-center">
              <img className="w-[42px] h-[42px] shrink-0 border border-[rgba(184,187,193,0.18)] rounded-full bg-[rgba(255,255,255,0.04)] object-cover" src={item.avatar} alt="" width={42} height={42} loading="lazy" decoding="async" />
              <figcaption>
                <strong className="block text-landing-ink text-[15px] font-[740] leading-[1.25]">{item.name}</strong>
                <span className="block mt-[3px] text-landing-muted text-xs leading-[1.35]">{item.role}</span>
              </figcaption>
            </div>
            <blockquote className="mt-[18px] text-sm font-[560] leading-[1.58] text-[color-mix(in_srgb,var(--color-landing-ink)_88%,var(--color-landing-muted))]">{item.quote}</blockquote>
          </figure>
        ))}
      </div>
    </div>
  );
}
