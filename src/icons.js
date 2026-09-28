// Centralized SVG vector icon system for Chess Arena.
// Eliminates platform-dependent emoji glyphs and provides responsive, stylable vector icons.

/**
 * Helper to build an accessible SVG element string.
 * @param {string} innerSvg - Inner SVG paths/shapes
 * @param {object} [opts]
 * @param {number} [opts.size=24] - width and height in px
 * @param {string} [opts.className=''] - extra CSS classes
 * @param {string} [opts.strokeWidth='2'] - stroke thickness
 * @param {string} [opts.fill='none'] - fill attribute
 * @param {string} [opts.stroke='currentColor'] - stroke color
 * @param {string} [opts.viewBox='0 0 24 24']
 * @returns {string} SVG HTML string
 */
function svg(innerSvg, {
  size = 24,
  className = '',
  strokeWidth = '2',
  fill = 'none',
  stroke = 'currentColor',
  viewBox = '0 0 24 24',
} = {}) {
  const cls = `svg-icon ${className}`.trim();
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="${viewBox}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${innerSvg}</svg>`;
}

// -----------------------------------------------------------------------------
// Action Strip & Navigation Icons
// -----------------------------------------------------------------------------

export function iconUndo(opts) {
  return svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>', opts);
}

export function iconHint(opts) {
  return svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z"/><line x1="12" y1="6" x2="12" y2="10"/><line x1="10" y1="8" x2="14" y2="8"/>', opts);
}

export function iconFlag(opts) {
  return svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>', opts);
}

export function iconFlip(opts) {
  return svg('<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>', opts);
}

export function iconPause(opts) {
  return svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', opts);
}

export function iconPlay(opts) {
  return svg('<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/>', opts);
}

export function iconSound(opts) {
  return svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>', opts);
}

export function iconMute(opts) {
  return svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>', opts);
}

export function iconHome(opts) {
  return svg('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>', opts);
}

export function iconShare(opts) {
  return svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>', opts);
}

export function iconRefresh(opts) {
  return svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>', opts);
}

export function iconSettings(opts) {
  return svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>', opts);
}

// -----------------------------------------------------------------------------
// Hero, Badges & Mode Icons
// -----------------------------------------------------------------------------

export function iconSwords(opts) {
  return svg(`
    <path d="M14.5 17.5L3 6V3h3l11.5 11.5"/>
    <path d="M13 19l6-6"/>
    <path d="M16 16l4 4"/>
    <path d="M19 21l2-2"/>
    <path d="M9.5 6.5L21 18v3h-3L6.5 9.5"/>
    <path d="M5 11l6-6"/>
    <path d="M8 8l-4-4"/>
    <path d="M5 3L3 5"/>
  `, opts);
}

export function iconLink(opts) {
  return svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', opts);
}

export function iconBolt(opts) {
  return svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"/>', opts);
}

export function iconBot(opts) {
  return svg('<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8.01" y2="16"/><line x1="16" y1="16" x2="16.01" y2="16"/>', opts);
}

export function iconArena(opts) {
  return svg('<polygon points="12 2 19 8 19 16 12 22 5 16 5 8 12 2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>', opts);
}

export function iconWrench(opts) {
  return svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', opts);
}

// -----------------------------------------------------------------------------
// Profile, Avatars & Rating Icons
// -----------------------------------------------------------------------------

export function iconUser(opts) {
  return svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', opts);
}

export function iconRobot(opts) {
  return svg('<rect x="4" y="8" width="16" height="12" rx="2"/><line x1="12" y1="4" x2="12" y2="8"/><circle cx="8" cy="13" r="1.5" fill="currentColor"/><circle cx="16" cy="13" r="1.5" fill="currentColor"/><line x1="9" y1="17" x2="15" y2="17"/>', opts);
}

export function iconRating(opts) {
  return svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', opts);
}

// -----------------------------------------------------------------------------
// Sandbox Tool Icons
// -----------------------------------------------------------------------------

export function iconMove(opts) {
  return svg('<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>', opts);
}

export function iconPalette(opts) {
  return svg('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>', opts);
}

export function iconTrash(opts) {
  return svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>', opts);
}

// -----------------------------------------------------------------------------
// Game Review System Icons
// -----------------------------------------------------------------------------

export function iconBarChart(opts) {
  return svg('<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>', opts);
}

export function iconTrendingUp(opts) {
  return svg('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>', opts);
}

export function iconAward(opts) {
  return svg('<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>', opts);
}

export function iconZap(opts) {
  return svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', opts);
}

export function iconSparkles(opts) {
  return svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>', opts);
}

export function iconAlertTriangle(opts) {
  return svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', opts);
}

export function iconCheckCircle(opts) {
  return svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', opts);
}

// -----------------------------------------------------------------------------
// Tabs & Log Icons
// -----------------------------------------------------------------------------

export function iconList(opts) {
  return svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>', opts);
}

export function iconTerminal(opts) {
  return svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', opts);
}
