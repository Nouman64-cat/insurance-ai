// A lead was just created in the portal. The Leads page announces it so the welcome tour
// (components/tour/AdminTour.tsx) can carry that exact lead through the next steps.
export const TOUR_LEAD_EVENT = "tour:lead-created";

export interface TourLead {
  id: string;
  name: string;
  type: string;
}

export const announceTourLead = (lead: TourLead) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TourLead>(TOUR_LEAD_EVENT, { detail: lead }));
};
