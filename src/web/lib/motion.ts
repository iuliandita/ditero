// motion/react takes seconds and a bezier tuple, so a FLIP transition cannot
// reference the --motion-* custom properties the CSS surfaces use. motion.test.ts
// pins these to index.css so the two frames cannot drift apart.
export const MOTION_BASE_SEC = 0.15;
export const MOTION_EASE: [number, number, number, number] = [0.2, 0, 0, 1];

export const FLIP_TRANSITION = {
	duration: MOTION_BASE_SEC,
	ease: MOTION_EASE,
} as const;
