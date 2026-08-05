import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const common = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  "aria-hidden": true,
} as const;

export function MemoryIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <path
        d="M5.3 3.2A3.3 3.3 0 0 0 2.5 6.5c0 .9.3 1.7.9 2.3-.2 1.8 1.1 3.2 2.8 3.2.8 0 1.5-.3 2-.8.6.5 1.3.8 2.1.8 1.7 0 3-1.4 2.8-3.2.6-.6.9-1.4.9-2.3a3.3 3.3 0 0 0-2.8-3.3A3.3 3.3 0 0 0 8.3 1.7a3.4 3.4 0 0 0-3 1.5Z"
        strokeLinejoin="round"
      />
      <path d="M6 5.3h4.2M5.5 8h5.2M6.5 10.6h3.4" strokeLinecap="round" />
    </svg>
  );
}

export function GraphIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <circle cx="3.5" cy="4" r="1.8" />
      <circle cx="12" cy="3.5" r="1.8" />
      <circle cx="8" cy="12" r="1.8" />
      <path d="M5.1 4.8 6.9 10.4M10.4 4.6 8.8 10.4M5.2 3.9 10.3 3.6" strokeLinecap="round" />
    </svg>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <circle cx="8" cy="5" r="2.25" />
      <path d="M3.5 13c.4-2.5 2-3.8 4.5-3.8s4.1 1.3 4.5 3.8" strokeLinecap="round" />
      <path d="M3.1 5.7 1.8 7l1.3 1.3M12.9 5.7 14.2 7l-1.3 1.3" strokeLinecap="round" />
    </svg>
  );
}

export function EvaluationIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <path
        d="M5.2 2.2h5.6M6.3 2.2v3.1l-3.1 5.4A1.9 1.9 0 0 0 4.9 13.5h6.2a1.9 1.9 0 0 0 1.7-2.8L9.7 5.3V2.2"
        strokeLinejoin="round"
      />
      <path d="M4.6 9.3h6.8" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.2 10.2 3.2 3.2" strokeLinecap="round" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: Shared icons are decorative inside labeled controls.
    <svg {...common} {...props}>
      <path d="M13 8H3M6.5 4.5 3 8l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
