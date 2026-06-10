"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";

const productSlides = [
  {
    src: "/screenshot-dark.png",
    alt: "DBX data grid and AI assistant screenshot",
    label: "Data grid",
  },
  {
    src: "/screenshot-connections.jpg",
    alt: "DBX connection management screenshot",
    label: "Connections",
  },
  {
    src: "/screenshot-grid.png",
    alt: "DBX table data grid screenshot",
    label: "Tables",
  },
  {
    src: "/screenshot-ai.jpg",
    alt: "DBX AI assistant screenshot",
    label: "AI",
  },
];

export function HeroProductStage() {
  const [activeSlide, setActiveSlide] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveSlide((current) => (current + 1) % productSlides.length);
    }, 4200);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <motion.div
      className="landing-product relative w-full mt-16 mb-12 overflow-hidden rounded-2xl max-[1040px]:max-w-[900px] max-[1040px]:mt-14 max-[760px]:mt-10 max-[760px]:mb-7 max-[760px]:rounded-xl"
      initial={{ opacity: 0, y: 36, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.9, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        {productSlides.map((slide, index) => (
          <img alt={slide.alt} aria-hidden={index !== activeSlide} className="landing-product-slide absolute inset-0 z-[1] w-full h-full object-cover object-left-top" data-active={index === activeSlide} key={slide.src} src={slide.src} />
        ))}
      </div>
      <div className="landing-product-dots absolute right-[18px] bottom-4 z-[5] flex gap-[7px] items-center rounded-full p-1.5 max-[760px]:right-3 max-[760px]:bottom-[11px]" aria-label="DBX product screenshots">
        {productSlides.map((slide, index) => (
          <button aria-current={index === activeSlide} aria-label={`Show ${slide.label} screenshot`} key={slide.src} onClick={() => setActiveSlide(index)} title={slide.label} type="button" className="block w-[9px] h-[9px] border-0 rounded-full p-0 cursor-pointer">
            <span>{slide.label}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
