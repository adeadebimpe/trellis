import React from 'react';

// Icon vectors exported from the Trellis Figma designs (webview/assets/*.svg).
// Strokes/fills are mapped to currentColor so both theme palettes work.

export function ChevronRightIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4.5 9L7.5 6L4.5 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronDownIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function PlusCircleIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.33311 8.00003H10.6669M7.99999 5.33314V10.6669M14.6672 8.00003C14.6672 11.6822 11.6822 14.6672 7.99999 14.6672C4.3178 14.6672 1.33279 11.6822 1.33279 8.00003C1.33279 4.31783 4.3178 1.33282 7.99999 1.33282C11.6822 1.33282 14.6672 4.31783 14.6672 8.00003Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function EllipsisVerticalIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7.99999 8.66658C8.36848 8.66658 8.66719 8.36813 8.66719 7.99998C8.66719 7.63182 8.36848 7.33337 7.99999 7.33337C7.63151 7.33337 7.33279 7.63182 7.33279 7.99998C7.33279 8.36813 7.63151 8.66658 7.99999 8.66658Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7.99999 4.00038C8.36848 4.00038 8.66719 3.70193 8.66719 3.33378C8.66719 2.96562 8.36848 2.66718 7.99999 2.66718C7.63151 2.66718 7.33279 2.96562 7.33279 3.33378C7.33279 3.70193 7.63151 4.00038 7.99999 4.00038Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7.99999 13.3328C8.36848 13.3328 8.66719 13.0343 8.66719 12.6662C8.66719 12.298 8.36848 11.9996 7.99999 11.9996C7.63151 11.9996 7.33279 12.298 7.33279 12.6662C7.33279 13.0343 7.63151 13.3328 7.99999 13.3328Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const PRIO_BARS = [
  'M3 10H1.5C1.22386 10 1 10.2239 1 10.5V12.5C1 12.7761 1.22386 13 1.5 13H3C3.27614 13 3.5 12.7761 3.5 12.5V10.5C3.5 10.2239 3.27614 10 3 10Z',
  'M7.5 6.5H6C5.72386 6.5 5.5 6.72386 5.5 7V12.5C5.5 12.7761 5.72386 13 6 13H7.5C7.77614 13 8 12.7761 8 12.5V7C8 6.72386 7.77614 6.5 7.5 6.5Z',
  'M12 2H10.5C10.2239 2 10 2.22386 10 2.5V12.5C10 12.7761 10.2239 13 10.5 13H12C12.2761 13 12.5 12.7761 12.5 12.5V2.5C12.5 2.22386 12.2761 2 12 2Z'
];

// Per-bar emphasis follows the Figma variants: high lights all bars,
// medium the first two, low only the first.
const PRIO_OPACITY: Record<'high' | 'medium' | 'low', [number, number, number]> = {
  high: [1, 1, 1],
  medium: [1, 1, 0.25],
  low: [0.55, 0.25, 0.25]
};

export function PriorityIcon({ level }: { level: 'high' | 'medium' | 'low' }): JSX.Element {
  const opacity = PRIO_OPACITY[level];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      {PRIO_BARS.map((d, index) => (
        <path key={d} d={d} fill="currentColor" fillOpacity={opacity[index]} />
      ))}
    </svg>
  );
}

export function LoaderPinwheelIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M12.8338 7C12.8338 7.77361 12.5265 8.51553 11.9795 9.06256C11.4324 9.60958 10.6905 9.9169 9.9169 9.9169C9.14329 9.9169 8.40136 9.60958 7.85434 9.06256C7.30731 8.51553 7 7.77361 7 7M12.8338 7C12.8338 10.2219 10.2219 12.8338 7 12.8338C3.77808 12.8338 1.1662 10.2219 1.1662 7M12.8338 7C12.8338 3.77808 10.2219 1.1662 7 1.1662C3.77808 1.1662 1.1662 3.77808 1.1662 7M7 7C7 6.22639 6.69268 5.48446 6.14566 4.93744C5.59863 4.39041 4.85671 4.0831 4.0831 4.0831C3.30949 4.0831 2.56756 4.39041 2.02054 4.93744C1.47351 5.48446 1.1662 6.22639 1.1662 7M7 7C6.32696 6.61319 5.52762 6.50982 4.7782 6.71222C4.02878 6.91462 3.39045 7.40644 3.00364 8.07948C2.61684 8.75252 2.51324 9.55165 2.71564 10.3011C2.91804 11.0505 3.40986 11.6888 4.0829 12.0756M7 7C7.32942 7.19153 7.69315 7.31652 8.07079 7.3674C8.44843 7.41828 8.8324 7.39428 9.20077 7.29677C9.56914 7.19926 9.91469 7.03015 10.2177 6.7991C10.5207 6.56804 10.7753 6.27957 10.9668 5.95014C11.1583 5.62072 11.2831 5.25679 11.334 4.87915C11.3848 4.50151 11.3608 4.11754 11.2633 3.74917C11.1658 3.3808 10.9967 3.03525 10.7657 2.73223C10.5346 2.42922 10.2461 2.17469 9.9167 1.98316M4.0831 1.92455C4.7484 1.53774 5.54012 1.43107 6.28407 1.628C7.02802 1.82493 7.66328 2.30933 8.05008 2.97463C8.43689 3.63994 8.54356 4.43165 8.34663 5.1756C8.1497 5.91956 7.6653 6.55481 7 6.94162C6.33469 7.32842 5.8503 7.96367 5.65337 8.70763C5.45644 9.45158 5.56311 10.2433 5.94991 10.9086C6.33672 11.5739 6.97197 12.0583 7.71593 12.2552C8.45988 12.4522 9.25159 12.3455 9.9169 11.9587"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ArrowLeftIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.9162L2.9162 7L7 11.0838M2.9162 7H11.0838" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowUpIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M11.0838 7L7 2.9162L2.9162 7M7 2.9162V11.0838" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function FlagIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.0004 11.0004V1.99965C2.0004 1.92202 2.01847 1.84546 2.05318 1.77603C2.08789 1.70659 2.13828 1.6462 2.20038 1.59962C2.71961 1.21012 3.35115 0.999573 4.0002 0.999573C5.50005 0.999573 6.49995 1.99965 7.66633 1.99965C8.33293 1.99965 8.84405 1.86631 9.19968 1.59962C9.27395 1.5439 9.36228 1.50997 9.45475 1.50163C9.54722 1.49329 9.64019 1.51087 9.72323 1.5524C9.80628 1.59393 9.87612 1.65777 9.92493 1.73677C9.97374 1.81576 9.9996 1.90679 9.9996 1.99965V7.00005C9.9996 7.07768 9.98153 7.15424 9.94682 7.22368C9.9121 7.29311 9.86171 7.35351 9.79962 7.40008C9.28038 7.78958 8.64884 8.00013 7.9998 8.00013C6.49995 8.00013 5.50005 7.00005 4.0002 7.00005C3.26233 7.00007 2.55035 7.27209 2.0004 7.76411"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BookmarkIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M9.20748 1.7929C9.01992 1.60536 8.76554 1.5 8.50029 1.5H3.49972C3.23447 1.5 2.98009 1.60536 2.79253 1.7929C2.60497 1.98044 2.4996 2.2348 2.4996 2.50002V10.0002C2.49963 10.0877 2.52266 10.1737 2.56637 10.2496C2.61009 10.3255 2.67296 10.3885 2.7487 10.4325C2.82445 10.4764 2.9104 10.4997 2.99797 10.5C3.08554 10.5003 3.17165 10.4776 3.24769 10.4342L5.50395 9.14514C5.65503 9.05885 5.82601 9.01346 6 9.01346C6.174 9.01346 6.34498 9.05885 6.49606 9.14514L8.75232 10.4342C8.82836 10.4776 8.91447 10.5003 9.00204 10.5C9.08961 10.4997 9.17556 10.4764 9.2513 10.4325C9.32705 10.3885 9.38992 10.3255 9.43364 10.2496C9.47735 10.1737 9.50038 10.0877 9.5004 10.0002V2.50002C9.5004 2.2348 9.39503 1.98044 9.20748 1.7929Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AtSignIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M8.00016 3.99982V6.50001C8.00016 6.89787 8.15821 7.27943 8.43954 7.56076C8.72087 7.84209 9.10243 8.00013 9.50028 8.00013C9.89814 8.00013 10.2797 7.84209 10.561 7.56076C10.8424 7.27943 11.0004 6.89787 11.0004 6.50001V5.99997C11.0004 4.87354 10.6201 3.7801 9.92102 2.89681C9.22197 2.01353 8.24517 1.39214 7.14886 1.13334C6.05256 0.87454 4.90099 0.99348 3.88072 1.47089C2.86046 1.9483 2.03127 2.75621 1.52752 3.76373C1.02376 4.77124 0.874938 5.91934 1.10517 7.022C1.3354 8.12465 1.93119 9.11728 2.79601 9.83904C3.66084 10.5608 4.74403 10.9694 5.87008 10.9987C6.99614 11.028 8.09909 10.6762 9.00024 10.0003M8.00016 5.99997C8.00016 7.10463 7.10466 8.00013 6 8.00013C4.89534 8.00013 3.99984 7.10463 3.99984 5.99997C3.99984 4.89531 4.89534 3.99981 6 3.99981C7.10466 3.99981 8.00016 4.89531 8.00016 5.99997Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// The woven-rails Trellis mark (media/trellis-icon.svg) on the dark logo tile
// from the design header; the middle rail carries the emerald accent.
export function TrellisLogo(): JSX.Element {
  return (
    <span className="logoTile" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <g strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round">
          <path stroke="#dcdad2" d="M4.5 20.5v-3.2c0-1.7 1-3.2 2.6-3.9l9.8-4.2a4.25 4.25 0 0 0 2.6-3.9V3.5" />
          <path stroke="#10b981" d="M12 20.5v-4.1a4.2 4.2 0 0 0-2.6-3.9L7.1 11.5a4.25 4.25 0 0 1-2.6-3.9V3.5" />
          <path stroke="#dcdad2" d="M19.5 20.5v-3.2c0-1.7-1-3.2-2.6-3.9l-2.3-1a4.2 4.2 0 0 1-2.6-3.9v-5" />
        </g>
      </svg>
    </span>
  );
}
