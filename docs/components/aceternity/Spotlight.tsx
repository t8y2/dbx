type SpotlightProps = {
  className?: string;
};

export function Spotlight({ className = "" }: SpotlightProps) {
  return <div aria-hidden="true" className={`aceternity-spotlight ${className}`} />;
}
