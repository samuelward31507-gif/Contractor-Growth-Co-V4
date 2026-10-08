/** A small, quiet confirmation mark for an approved quote. */
export function CheckMark() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="h-[18px] w-[18px] shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="10" cy="10" r="8.25" strokeWidth={1.5} />
      <path d="M6.5 10.2l2.3 2.3 4.7-4.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
