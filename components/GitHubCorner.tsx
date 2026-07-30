import React from 'react';
import { Github } from 'lucide-react';

/**
 * Side of the square the triangle is cut from, in pixels.
 * Matches the footer's height (h-10) so the ribbon never reaches the timeline.
 */
export const CORNER_SIZE = 40;

interface GitHubCornerProps {
  href: string;
}

/**
 * Small "view source" ribbon pinned to the bottom-left corner.
 *
 * Sized to the footer's height so it never reaches up into the global timeline,
 * which is click-to-seek — a taller ribbon would swallow seeks near 0:00. The
 * anchor is clipped to the triangle as well, so the transparent half above the
 * diagonal does not capture clicks either. The footer's left padding is widened
 * to match, so the timecode is not covered. Sits above the footer, below modals.
 */
export const GitHubCorner: React.FC<GitHubCornerProps> = ({ href }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="View the source on GitHub"
    title="View the source on GitHub"
    className="group fixed bottom-0 left-0 z-[60] block"
    style={{
      width: CORNER_SIZE,
      height: CORNER_SIZE,
      clipPath: 'polygon(0 0, 0 100%, 100% 100%)',
    }}
  >
    <svg
      width={CORNER_SIZE}
      height={CORNER_SIZE}
      viewBox={`0 0 ${CORNER_SIZE} ${CORNER_SIZE}`}
      className="absolute inset-0"
      aria-hidden="true"
    >
      <polygon
        points={`0,0 0,${CORNER_SIZE} ${CORNER_SIZE},${CORNER_SIZE}`}
        className="fill-daw-border transition-colors group-hover:fill-daw-accent"
      />
    </svg>
    <Github
      size={15}
      className="absolute bottom-[7px] left-[7px] text-daw-muted transition-colors group-hover:text-white"
    />
  </a>
);
