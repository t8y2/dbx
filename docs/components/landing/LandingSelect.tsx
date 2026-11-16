"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface LandingSelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Landing-styled dropdown replacing native <select>, which cannot be themed to
 * match the dark landing cards. The option list renders in a body portal with
 * fixed coordinates so `overflow-hidden` cards and scrollable table rows never
 * clip it; it closes on outside click, Escape, and scroll/resize.
 */
export function LandingSelect<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  className = "",
}: {
  value: T;
  options: ReadonlyArray<LandingSelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties | null>(null);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLUListElement>(null);

  const toggle = (next: boolean) => {
    if (!next) {
      setOpen(false);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const dropUp = window.innerHeight - rect.bottom < 280 && rect.top > 280;
      setPopupStyle({
        position: "fixed",
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 200) - 8)),
        minWidth: rect.width,
        ...(dropUp ? { bottom: `${window.innerHeight - rect.top + 4}px` } : { top: `${rect.bottom + 4}px` }),
      });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onAnchorMoved = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onAnchorMoved, true);
    window.addEventListener("resize", onAnchorMoved);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onAnchorMoved, true);
      window.removeEventListener("resize", onAnchorMoved);
    };
  }, [open]);

  const selected = options.find((option) => option.value === value);
  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  };

  const onButtonKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
      toggle(true);
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && toggle(!open)}
        onKeyDown={onButtonKeyDown}
        className="inline-flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-[6px] border border-landing-line bg-black/10 px-2.5 text-xs text-landing-ink outline-none transition-colors hover:border-landing-blue focus:border-landing-blue disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0 truncate">{selected?.label ?? value}</span>
        <ChevronDown size={13} className={`shrink-0 text-landing-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        createPortal(
          <ul
            ref={popupRef}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            onKeyDown={onListKeyDown}
            style={popupStyle ?? undefined}
            className="z-50 max-h-[260px] w-max min-w-[200px] overflow-y-auto rounded-[7px] border border-landing-line bg-[#202123] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)] outline-none"
          >
            {options.map((option, index) => (
              <li key={option.value} role="option" aria-selected={option.value === value}>
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(index)}
                  className={`flex w-full cursor-pointer items-center justify-between gap-3 whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors ${option.value === value ? "text-landing-sky" : "text-landing-ink"} ${index === activeIndex ? "bg-landing-soft" : ""}`}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.value === value && <Check size={13} className="shrink-0" />}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
