// A control that a touch row reaches another way (long-press, reorder mode):
// on a coarse pointer it leaves the layout, so it is no mis-tap target, yet it
// stays a tab stop and reappears while keyboard-focused or while its menu is
// open (a Radix menu anchors to its trigger's box).
export const TOUCH_KEYBOARD_ONLY =
	"pointer-coarse:[&:not(:focus-visible):not([aria-expanded=true])]:sr-only";
