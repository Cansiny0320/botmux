import { confirm } from './confirm-modal.js';

// A page holding unsaved edits registers a guard; the shell asks it before a
// hash navigation tears the page down. With no guard registered (every page
// but the ones that opt in) navigation behaves exactly as before.

export interface LeavePrompt {
  title: string;
  message: string;
  confirmLabel?: string;
}

type LeaveGuard = () => LeavePrompt | null;

let guard: LeaveGuard | null = null;
// The hash the user already agreed to leave for: its own hashchange must pass.
let approvedTarget: string | null = null;

export function setLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => { if (guard === next) guard = null; };
}

export function pendingLeavePrompt(): LeavePrompt | null {
  return guard?.() ?? null;
}

/**
 * Call from the hashchange handler before routing. Returns true when the
 * navigation was held back: the URL is put back to `from` (replaceState fires
 * no hashchange) and the page stays mounted; on confirmation the shell is sent
 * to `to` again and that second hashchange is let through.
 */
export function holdHashNavigation(from: string, to: string): boolean {
  if (approvedTarget === to) {
    approvedTarget = null;
    return false;
  }
  const prompt = pendingLeavePrompt();
  if (!prompt) return false;
  history.replaceState(history.state, '', from);
  void confirm({ ...prompt, danger: true }).then(ok => {
    if (!ok) return;
    approvedTarget = to;
    location.hash = to;
  });
  return true;
}
