// The welcome tour an Admin sees on their first sign-in. It is a guided walk-through, not a slideshow: the page
// stays fully usable, each step spotlights the area to use, and where it matters the tour waits for the Admin
// to do the real action (save a lead, send a proposal to underwriting) and then moves on by itself. The lead
// they create in step 2 is followed through the later steps and highlighted on each page.
// Add or reword steps here; the component (components/tour/AdminTour.tsx) needs no change.

import type { TourLead } from "./events";

export interface TourContext {
  /** The lead created during the tour, once there is one. */
  lead: TourLead | null;
}

export interface TourStep {
  id: string;
  /** Page opened when the step starts. */
  route: string;
  /** Sidebar link used when the area below can't be found: matches the `data-tour` attribute set in Sidebar.tsx. */
  target: string;
  /**
   * The area of the PAGE this step is about. Returns the element(s) to spotlight (several together become one box);
   * empty means "not on screen (yet)". Called continuously, so it can follow a dialog opening or a list filling in.
   */
  find?: (ctx: TourContext) => HTMLElement[];
  /** A line that changes with where the Admin is right now (e.g. which proposal button to press next). Re-read often. */
  hint?: (ctx: TourContext) => string | null;
  /** `{lead}` in any text is replaced by the name of the lead created in the tour. */
  title: string;
  summary: string;
  /** "What to do here": a few short actions, in order. */
  todo: string[];
  /** Shown while the tour waits for the Admin to do the real action. */
  waitHint?: string;
  /** The step is finished when the Admin saves a lead (the Leads page announces it). */
  advanceOnLead?: boolean;
  /** Finished when this returns true, checked as the page changes. */
  doneWhen?: (ctx: TourContext, pathname: string) => boolean;
  /** Said when the step is finished, just before the tour moves on. */
  doneNote?: string;
  /** How long to leave the Admin on the result before moving on. */
  advanceDelayMs?: number;
}

// ── Finding the area to spotlight ───────────────────────────────────────────────

const page = () => document.querySelector("main") ?? document;
const visible = (el: HTMLElement) => el.getClientRects().length > 0;
const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

/** Buttons / links in the page whose visible label matches. */
const withText = (selector: string, re: RegExp): HTMLElement[] =>
  Array.from(page().querySelectorAll<HTMLElement>(selector)).filter((el) => visible(el) && re.test(text(el)));

/** The toolbar around the page's search box (search + filters). The top bar's own global search is not included. */
const searchToolbar = (): HTMLElement[] => {
  const input = Array.from(page().querySelectorAll<HTMLInputElement>('input[placeholder*="earch"]')).find(visible);
  const bar = input?.closest<HTMLElement>('div[class*="flex-wrap"], div[class*="rounded-xl"]');
  return bar ? [bar] : input ? [input] : [];
};

/** The dialog that is open right now (the add-lead form, say), if any. */
const openDialog = (): HTMLElement[] => {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>('div[class*="fixed"][class*="inset-0"]')).filter(
    (el) => visible(el) && !el.closest("[data-tour-ui]")
  );
  const panel = overlays[overlays.length - 1]?.firstElementChild as HTMLElement | null | undefined;
  return panel && visible(panel) ? [panel] : [];
};

/**
 * The row / card / folder that shows this person, so the Admin can see exactly where their lead is.
 * Walks only the page's text nodes (cheap, no layout) and remembers the row until React replaces it,
 * because this runs several times a second on pages with a lot of rows.
 */
const rowCache = new Map<string, HTMLElement>();
const rowFor = (name?: string): HTMLElement[] => {
  if (!name) return [];
  const cached = rowCache.get(name);
  if (cached && cached.isConnected && visible(cached)) return [cached];
  const needle = name.toLowerCase();
  const walker = document.createTreeWalker(page(), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) continue;
    const el = node.parentElement;
    if (!el || el.closest("[data-tour-ui]") || !visible(el)) continue;
    const row = el.closest<HTMLElement>("tr") ?? el.closest<HTMLElement>('div[class*="rounded-"]') ?? el;
    rowCache.set(name, row);
    return [row];
  }
  return [];
};

/** The action bar of the open dialog: the "pick what to do" list and its Apply button. */
const dialogAction = (): HTMLElement[] => {
  const dialog = openDialog()[0];
  if (!dialog) return [];
  const apply = Array.from(dialog.querySelectorAll<HTMLElement>("button")).find((b) => /^(Apply|Applying…?)$/.test(text(b)));
  return apply?.parentElement ? [apply.parentElement] : [];
};

/** Which proposal button is next, from the status shown on the open proposal or on the lead's row. */
const proposalHint = (ctx: TourContext): string | null => {
  const dialog = openDialog()[0];
  const row = rowFor(ctx.lead?.name)[0];
  if (!dialog && !row) return "Find the highlighted lead in the list below.";
  const scope = dialog ? text(dialog).slice(0, 140) : text(row).slice(0, 400);
  const pick = (what: string) => (dialog ? `Now: choose “${what}” in the highlighted box and press Apply.` : `Open the highlighted proposal, then choose “${what}” and press Apply.`);
  if (/Under Review/i.test(scope)) return pick("Send to Underwriting");
  if (/Info Requested|InformationRequested/i.test(scope)) return pick("Re-Submit Proposal");
  if (/Submitted/i.test(scope)) return pick("Start Review");
  if (/Draft/i.test(scope)) return pick("Submit Proposal");
  return dialog ? null : "Click the highlighted row to open the proposal.";
};

export const fillLead = (s: string, ctx: TourContext) => s.split("{lead}").join(ctx.lead?.name ?? "your lead");

export const ADMIN_TOUR_STEPS: TourStep[] = [
  {
    id: "source",
    route: "/admin/acquisition-sources",
    target: "/admin/acquisition-sources",
    find: () => openDialog().length ? openDialog() : withText("button", /^\+?\s*Add Source$/),
    title: "Add an Acquisition Source",
    summary:
      "An acquisition source is whoever brings a customer to you: an agent, a broker, a bank desk, a corporate partner, a walk-in desk or your website. Set these up first, so every lead can be credited to its source and sent to the right person.",
    todo: [
      "Click the highlighted “Add Source” button. Everything on the page works while the tour is open.",
      "Pick the type (Agent, Broker, Bancassurance, Corporate Agent, Walk-in or Digital), then enter the name and code.",
      "Add a contact email and the source gets its own login, so an agent receives their leads on the mobile app.",
      "Press Next when you are done, or to skip this one.",
    ],
  },
  {
    id: "lead",
    route: "/admin/leads",
    target: "/admin/leads",
    find: () => (openDialog().length ? openDialog() : withText("button", /^\+\s*Add (Individual|Family|Corporate)$/)),
    title: "Add your first lead",
    summary:
      "Leads is where every prospect starts: an Individual, a Family group or a Corporate (company). Add one now. You will follow this same lead through proposal, underwriting and issuance.",
    todo: [
      "Click one of the highlighted buttons: Add Individual, Add Family or Add Corporate.",
      "Choose “Complete details” so you can attach a plan (Quick lead is only a name and phone). Pick the lead source type, then the specific source.",
      "For an individual, also choose an insurance plan, cover amount and term. That is what creates the proposal in the next step.",
      "Save the lead with the button at the bottom of the form. The tour moves on by itself.",
    ],
    waitHint: "Waiting for you to save a lead…",
    advanceOnLead: true,
    doneNote: "Lead saved. Taking you to its proposal…",
    advanceDelayMs: 1800,
  },
  {
    id: "proposal",
    route: "/proposal",
    target: "/proposal",
    find: (ctx) => {
      // With the proposal open, point at the buttons that move it on; otherwise at the lead's row.
      const action = dialogAction();
      if (action.length) return action;
      const row = rowFor(ctx.lead?.name);
      return row.length ? row : openDialog().length ? openDialog() : searchToolbar();
    },
    hint: proposalHint,
    title: "Proposal for {lead}",
    summary:
      "A proposal is the lead with a plan and a premium. {lead} is highlighted below. If you see a draft without a quote, add a plan to the lead first (Leads, open the lead, Assign New Insurance Plan).",
    todo: [
      "Click the highlighted row, then open the proposal.",
      "Press “Submit Proposal”.",
      "Press “Start Review”. Use “Request Info” instead if details are missing.",
      "Press “Send to Underwriting”. That opens the underwriting case, and the tour moves on.",
    ],
    waitHint: "Waiting for the proposal to be sent to underwriting…",
    doneWhen: (_ctx, pathname) => pathname.startsWith("/case/"),
    doneNote: "Sent to underwriting. Next, see where it landed…",
    advanceDelayMs: 3500,
  },
  {
    id: "underwriting",
    route: "/underwriting",
    target: "/underwriting",
    find: (ctx) => {
      const row = rowFor(ctx.lead?.name);
      if (row.length) return row;
      const gate = Array.from(page().querySelectorAll<HTMLElement>("h4")).find((h) => visible(h) && /^Gate \d/.test(text(h)));
      const card = gate?.closest<HTMLElement>('div[class*="rounded-2xl"]');
      return card ? [card] : searchToolbar();
    },
    title: "Underwriting for {lead}",
    summary:
      "Each case is checked before a decision. Six gates come first: e-application, the agent's confidential report, sanctions screening, first premium, insurance history and medical. Then the AI scores the risk and the rules decide. {lead}'s case is highlighted when it is on this page.",
    todo: [
      "Open the highlighted case and work through its gates in order; each one unlocks the next.",
      "When the gates are clear, run the AI risk assessment.",
      "Read the decision and its reasons, then approve, load or decline.",
      "Press Next when you are ready to see issuance.",
    ],
  },
  {
    id: "issuance",
    route: "/policy-issuance",
    target: "/policy-issuance",
    find: (ctx) => {
      const row = rowFor(ctx.lead?.name);
      if (row.length) return row;
      const grid = page().querySelector<HTMLElement>('div[class*="lg:grid-cols-5"]');
      return grid && visible(grid) ? [grid] : [];
    },
    title: "Policy Issuance for {lead}",
    summary:
      "An approved case turns into a policy here. The Pre-Issuance queue holds cases waiting to be issued, and the Post-Issuance queue follows policies after they are issued. {lead} appears once the case is approved.",
    todo: [
      "Open the case from the Pre-Issuance queue and check the nominees (beneficiaries) and documents.",
      "Issue the policy, then confirm the first payment to make it active.",
      "Use the Post-Issuance queue for the welcome pack and onboarding.",
    ],
  },
  {
    id: "active",
    route: "/admin/policyholders",
    target: "/admin/policyholders",
    find: (ctx) => {
      const row = rowFor(ctx.lead?.name);
      return row.length ? row : searchToolbar();
    },
    title: "Active policies and cases",
    summary:
      "Policy Holders lists customers with issued, active policies. Once {lead} is issued, you will find them here. Cases keeps the full record of every case, so you can look back at how a decision was made.",
    todo: [
      "Use search and filters to find a policyholder, then open them to see their policies.",
      "Open Cases from the sidebar for the history, documents and notes on any case.",
      "You can replay this tour any time from “Take the tour” at the top of the page.",
    ],
  },
];
