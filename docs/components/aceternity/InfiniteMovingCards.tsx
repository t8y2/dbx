"use client";

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

export function InfiniteMovingCards({ items, direction = "left", speed = "normal" }: InfiniteMovingCardsProps) {
  const repeatedItems = [...items, ...items];

  return (
    <div className="landing-testimonial-marquee flex overflow-hidden select-none" data-direction={direction} data-speed={speed} aria-label="Testimonials">
      <div className="landing-testimonial-track flex w-max min-w-full gap-3.5 px-[7px]">
        {repeatedItems.map((item, index) => (
          <figure className="landing-testimonial-card flex-[0_0_340px] min-h-[188px] rounded-[9px] m-0 p-[22px] max-[760px]:flex-[0_0_286px] max-[760px]:min-h-[210px] max-[760px]:p-[18px]" key={`${item.name}-${index}`}>
            <div className="flex gap-3 items-center">
              <img className="w-[42px] h-[42px] shrink-0 border border-[rgba(178,200,230,0.18)] rounded-full bg-[rgba(255,255,255,0.04)] object-cover" src={item.avatar} alt="" width={42} height={42} />
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
