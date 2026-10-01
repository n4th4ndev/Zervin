"use client";

// The Zevrin mark: a tile split into two flat fields whose cut draws a Z. In one color (inside the app UI) the cut
// opens into a Z-shaped channel between the two pieces; `ZevrinIcon` is the full two-color app icon.
export function ZevrinMark({ size = 24, title }: { size?: number; title?: string }) {
  return <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title} className="zevrin-mark">
    <path d="M4.27 21.42A20.77 20.77 0 0 1 24.77 4H75.23A20.77 20.77 0 0 1 96 24.77V62.38H44.77L85.73 21.42Z"/>
    <path d="M4 34.05H55.23L14.27 75.01H96V75.23A20.77 20.77 0 0 1 75.23 96H24.77A20.77 20.77 0 0 1 4 75.23V34.05Z"/>
  </svg>;
}

export function ZevrinIcon({ size = 64, title }: { size?: number; title?: string }) {
  return <svg width={size} height={size} viewBox="100 100 824 824" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title} className="zevrin-icon">
    <path fill="#F1ECE4" d="M103.92 248H856L216 728H924V738A186 186 0 0 1 738 924H286A186 186 0 0 1 100 738V286A186 186 0 0 1 103.92 248Z"/>
    <path fill="#F4511E" d="M102.44 256A186 186 0 0 1 286 100H738A186 186 0 0 1 924 286V736H192L832 256Z"/>
  </svg>;
}
