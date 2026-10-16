import type { CSSProperties, ReactNode } from 'react';

/** Thin wrappers over the Industry classes in ds.css. They add markup, never new styles. */

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const ALL_CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br'];

export function Blueprint({
  as: Tag = 'div',
  className = '',
  corners = ALL_CORNERS,
  children,
  ...rest
}: {
  as?: 'div' | 'section' | 'aside';
  className?: string;
  corners?: Corner[];
  children?: ReactNode;
  style?: CSSProperties;
  id?: string;
  role?: string;
  tabIndex?: number;
  'aria-labelledby'?: string;
  'aria-modal'?: boolean;
}) {
  return (
    <Tag className={`blueprint ${className}`} {...rest}>
      {corners.map((c) => (
        <i key={c} className={`corner ${c}`} aria-hidden="true" />
      ))}
      {children}
    </Tag>
  );
}

export type SevKind = 'high' | 'medium' | 'low' | 'none' | 'mine';

export function SevTag({ kind, children }: { kind: SevKind; children: ReactNode }) {
  return <span className={`tag sev sev-${kind}`}>{children}</span>;
}

export function Seg<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
}: {
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className="seg-opt">
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

const ICONS = {
  branch: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </>
  ),
  lens: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m18 15-6-6-6 6" />,
  arrowDown: (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  arrowUpRight: (
    <>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </>
  ),
  expand: (
    <>
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
};

/** Lucide paths at stroke 1.5, per the design system. */
export function Icon({
  name,
  size = 14,
  style,
}: {
  name: keyof typeof ICONS;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {ICONS[name]}
    </svg>
  );
}
