/**
 * UI navigation (b47) — the screen stack as a pure state machine.
 *
 * The stack is over the four pinned app screens (BR-07's APP_SCREENS)
 * plus the "match" overlay the discovery surface pushes when a diagram
 * arrives. The match overlay is hosted on discovery: the safety tray is
 * rendered globally, so BR-07's two-tap budget is measured through the
 * host — {@link safetyHostScreen} pins that mapping.
 *
 * Every illegal move fails closed to the unchanged state: an unknown
 * destination, a duplicate push onto the current screen, or a back from
 * the root all return the state as-is. Navigation can never strand the
 * user on an unregistered screen because one cannot be entered.
 */

import {
  APP_SCREENS,
  MAX_SAFETY_TAPS,
  SAFETY_ACTIONS,
  planSafetyAccess,
  type AppScreen,
} from "../reportFlow.js";

/** Every screen the shell can navigate to: the four app screens + match. */
export const NAV_SCREENS = [...APP_SCREENS, "match"] as const;

export type NavScreen = (typeof NAV_SCREENS)[number];

/** The root screen — the stack can never be emptied past it. */
export const ROOT_SCREEN: AppScreen = "discovery";

export interface NavigationState {
  readonly stack: readonly NavScreen[];
}

export function initialNavigation(): NavigationState {
  return { stack: [ROOT_SCREEN] };
}

function isNavScreen(screen: string): screen is NavScreen {
  return (NAV_SCREENS as readonly string[]).includes(screen);
}

/** The screen the user is looking at — the top of the stack. */
export function currentScreen(state: NavigationState): NavScreen {
  const top = state.stack[state.stack.length - 1];
  return top ?? ROOT_SCREEN;
}

/**
 * The screen whose safety plan governs this screen: the match overlay
 * inherits discovery's — the tray is global, so the two-tap budget is
 * unchanged whichever screen hosts it.
 */
export function safetyHostScreen(screen: NavScreen): AppScreen {
  return screen === "match" ? "discovery" : screen;
}

/**
 * Push a screen. Unknown destinations and pushes onto the current
 * screen fail closed to the unchanged state.
 */
export function navigateTo(
  state: NavigationState,
  screen: string,
): NavigationState {
  if (!isNavScreen(screen)) return state;
  if (currentScreen(state) === screen) return state;
  return { stack: [...state.stack, screen] };
}

/** Pop one screen. Back from the root stays at the root. */
export function goBack(state: NavigationState): NavigationState {
  if (state.stack.length <= 1) return state;
  return { stack: state.stack.slice(0, -1) };
}

/** Reset to the root — e.g. after logout or a stale-version refusal. */
export function resetNavigation(): NavigationState {
  return initialNavigation();
}

/**
 * BR-07 from the navigator's side: from every reachable screen, every
 * one of the five safety actions plans within the two-tap budget via
 * the host screen — and every plan is free by construction.
 */
export function safetyReachable(state: NavigationState): boolean {
  void state; // reachability is a property of the screen set, not the stack
  return NAV_SCREENS.every((screen) =>
    SAFETY_ACTIONS.every((action) => {
      const plan = planSafetyAccess(safetyHostScreen(screen), action);
      return plan !== null && plan.taps <= MAX_SAFETY_TAPS && plan.free;
    }),
  );
}
