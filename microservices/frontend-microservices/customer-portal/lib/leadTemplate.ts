// How the published "Lead acquisition" template meets the hand-built Add Customer form.
//
// The form's original fields are built into it (they have their own validation, plan rules and storage). Everything a Super Admin ADDS in the
// Templates tab (fields stored under `details.custom`, and whole new sections) is drawn from the template at run time and saved with the customer
// in `details.custom`, next to the template version it was answered under. A section that has the same id as one of the form's tabs adds its
// new fields to the bottom of that tab; a section the form does not have becomes a new tab before the plan tab. Tab names follow the template.
export interface Option { id: string; label: string; value?: string }
export interface Field {
  id: string; label: string; type: string; required?: boolean; help?: string; locked?: boolean; options?: Option[];
  show_if?: { field: string; equals: string }; binding?: { store: "profile" | "details"; key?: string }; placeholder?: string; max_length?: number;
}
export interface Section { id: string; title: string; description?: string | null; fields: Field[] }
export interface TemplateContent { title: string; intro?: string; sections: Section[]; disclaimers?: string[] }

/** The template's section ids and the form's tab ids that mean the same thing. */
export const TAB_OF_SECTION: Record<string, string> = {
  demographics: "demographics", cnic: "cnic", employment: "employment", medical: "medical", habit: "habit_check", financial: "financial",
  beneficiary: "beneficiary", plan: "insurance_plan",
};
export const EXTRA_TAB_PREFIX = "tpl:";
/** The types the form can draw for an added field. */
export const RENDERABLE = ["text", "textarea", "number", "date", "phone", "checkbox", "yes_no", "select"] as const;

export type Custom = Record<string, string | number | boolean | null | undefined>;

/** A field a person added (not one of the form's own): it is stored under details.custom. */
export const isAdded = (f: Field): boolean => f.binding?.store === "details";

export interface Split {
  tabLabels: Record<string, string>;                 // form tab id -> the template's name for it
  extraByTab: Record<string, Field[]>;               // form tab id -> added fields to draw at the bottom of that tab
  extraTabs: Section[];                              // sections the form does not have: new tabs, with only their added fields
}

export function splitTemplate(content: TemplateContent | null | undefined): Split {
  const out: Split = { tabLabels: {}, extraByTab: {}, extraTabs: [] };
  if (!content) return out;
  for (const s of content.sections) {
    const tab = TAB_OF_SECTION[s.id];
    const added = s.fields.filter(isAdded);
    if (tab) {
      if (s.title?.trim()) out.tabLabels[tab] = s.title;
      if (added.length) out.extraByTab[tab] = added;
    } else if (added.length || s.fields.length === 0) {
      out.extraTabs.push({ ...s, fields: added });
    }
  }
  return out;
}

/** Whether a field is shown: a "show only if" rule compares the earlier answer with the expected text. */
export function isVisible(f: Field, values: Custom): boolean {
  if (!f.show_if) return true;
  const v = values[f.show_if.field];
  const shown = v === true ? "Yes" : v === false ? "No" : v == null ? "" : String(v);
  return shown === f.show_if.equals;
}

const blank = (v: unknown) => v === undefined || v === null || v === "" || v === false;

/** Required added fields with no answer, with the tab each belongs to (so the form can take the person to it). */
export function missingRequired(content: TemplateContent | null | undefined, values: Custom): { tab: string; field: Field }[] {
  const out: { tab: string; field: Field }[] = [];
  for (const s of content?.sections ?? []) {
    const tab = TAB_OF_SECTION[s.id] ?? EXTRA_TAB_PREFIX + s.id;
    for (const f of s.fields.filter(isAdded)) {
      if (f.required && isVisible(f, values) && blank(values[f.id])) out.push({ tab, field: f });
    }
  }
  return out;
}

/** The answers worth saving: only fields that still exist in the template and are visible, so a removed field leaves no stale answer behind. */
export function cleanAnswers(content: TemplateContent | null | undefined, values: Custom): Custom {
  const keep: Custom = {};
  for (const s of content?.sections ?? []) {
    for (const f of s.fields.filter(isAdded)) if (isVisible(f, values) && values[f.id] !== undefined) keep[f.id] = values[f.id];
  }
  return keep;
}
