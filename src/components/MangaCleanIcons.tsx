import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * MangaClean Atelier Brand Icon
 * A manga dialogue bubble combined with an inpainting sparkle.
 * Complies with Lucide 24x24 geometric grid and stroke contract.
 */
export const MangaCleanLogo = forwardRef<SVGSVGElement, LucideProps>(({
  size = 24,
  color = 'currentColor',
  strokeWidth = 2,
  className,
  ...props
}, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    {/* Manga speech bubble envelope */}
    <path d="M20 11.5a7.5 7.5 0 0 0-7.5-7.5C8.36 4 5 7.36 5 11.5c0 1.68.56 3.23 1.5 4.5L5 19.5l3.8-1.2a7.47 7.47 0 0 0 3.7.9c4.14 0 7.5-3.36 7.5-7.7z" />
    {/* Center inpaint cleaning sparkle */}
    <path d="M12.5 8c0 1.7-1.3 3-3 3 1.7 0 3 1.3 3 3 0-1.7 1.3-3 3-3-1.7 0-3-1.3-3-3z" />
    {/* Top-right accent sparkle */}
    <path d="M18 2v3" />
    <path d="M16.5 3.5h3" />
  </svg>
));
MangaCleanLogo.displayName = 'MangaCleanLogo';

/**
 * Box Draw / Manual Selection Tool Icon
 * Precision bounding box with corner node guides.
 * Replaces the raw CSS `.box-tool-icon` span with a true Lucide-grade SVG component.
 */
export const BoxToolIcon = forwardRef<SVGSVGElement, LucideProps>(({
  size = 24,
  color = 'currentColor',
  strokeWidth = 2,
  className,
  ...props
}, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    {/* Outer corner crop / alignment guides */}
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    {/* Central bounding selection box */}
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </svg>
));
BoxToolIcon.displayName = 'BoxToolIcon';

/**
 * Bubble & Text Detection Scanner Icon
 * An optical scan frame bounding a manga dialogue bubble.
 */
export const BubbleDetectIcon = forwardRef<SVGSVGElement, LucideProps>(({
  size = 24,
  color = 'currentColor',
  strokeWidth = 2,
  className,
  ...props
}, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    {/* Contained dialogue bubble shape */}
    <path d="M8 14l-2 2.5V14a4 4 0 0 1-1-2.5 4.5 4.5 0 0 1 4.5-4.5h5A4.5 4.5 0 0 1 19 11.5a4.5 4.5 0 0 1-4.5 4.5H9z" />
  </svg>
));
BubbleDetectIcon.displayName = 'BubbleDetectIcon';

/**
 * Inpaint & Clean Action Icon
 * Angled cleaning tool with inpaint restoration sparkle.
 */
export const CleanInpaintIcon = forwardRef<SVGSVGElement, LucideProps>(({
  size = 24,
  color = 'currentColor',
  strokeWidth = 2,
  className,
  ...props
}, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    {/* Clean sweep wedge */}
    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
    <path d="M22 21H7" />
    <path d="m5 11 9 9" />
    {/* Inpainting sparkle indicator */}
    <path d="M19 2v4" />
    <path d="M17 4h4" />
  </svg>
));
CleanInpaintIcon.displayName = 'CleanInpaintIcon';

/**
 * Dual-Canvas Split View Icon
 * Symmetrical 1:1 dual panes for Original vs Cleaned viewports.
 */
export const DualCanvasSplitIcon = forwardRef<SVGSVGElement, LucideProps>(({
  size = 24,
  color = 'currentColor',
  strokeWidth = 2,
  className,
  ...props
}, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
    <path d="M7 8l-2 4 2 4" />
    <path d="M17 8l2 4-2 4" />
  </svg>
));
DualCanvasSplitIcon.displayName = 'DualCanvasSplitIcon';

/**
 * Quick Export Tray Icon
 * Direct export action icon for the Top Atelier Bar.
 */
export const ExportTrayIcon = forwardRef<SVGSVGElement, LucideProps>(({
  size = 24,
  color = 'currentColor',
  strokeWidth = 2,
  className,
  ...props
}, ref) => (
  <svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
));
ExportTrayIcon.displayName = 'ExportTrayIcon';
