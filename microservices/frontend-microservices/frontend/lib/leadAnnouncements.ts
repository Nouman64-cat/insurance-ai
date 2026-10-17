// The Leads board announces a lead that appears in its polled list ("New lead added"). A form that
// creates a lead in several steps (the full corporate entry) writes the organization first, so the
// board would announce it before the form has succeeded — and again for nothing if the form rolls back.
// Such a form pauses announcements while it saves; the board checks this before raising one.

let pauses = 0;

/** Pause lead announcements; call the returned function to resume. Safe to call it more than once. */
export function pauseLeadAnnouncements(): () => void {
  pauses += 1;
  let released = false;
  return () => {
    if (!released) { released = true; pauses = Math.max(0, pauses - 1); }
  };
}

export const leadAnnouncementsPaused = (): boolean => pauses > 0;
