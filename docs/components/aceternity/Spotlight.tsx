"use client";

import { motion } from "motion/react";

type SpotlightProps = {
  className?: string;
};

export function Spotlight({ className = "" }: SpotlightProps) {
  return <motion.div aria-hidden="true" className={`aceternity-spotlight ${className}`} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }} />;
}
