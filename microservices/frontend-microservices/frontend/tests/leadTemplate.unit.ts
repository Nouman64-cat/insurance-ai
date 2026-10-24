// What the Add Customer form draws from the Lead acquisition template, and what it saves. Pure logic from lib/leadTemplate.ts, plus one read of the
// live published template from the gateway to confirm that today it adds nothing to the form (every field is built in).
import api from "@/app/services/api";
import { cleanAnswers, isVisible, missingRequired, splitTemplate, TAB_OF_SECTION } from "@/lib/leadTemplate";
import { getPublished, type Field, type TemplateContent } from "@/lib/templates";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const builtIn = (id: string): Field => ({ id, label: id, type: "text", binding: { store: "profile", key: id } });
const added = (id: string, extra: Partial<Field> = {}): Field => ({ id, label: id, type: "text", binding: { store: "details" }, ...extra });

async function main(): Promise<number> {
  const content: TemplateContent = {
    title: "Lead", sections: [
      { id: "demographics", title: "Who they are", fields: [builtIn("first_name"), added("blood_group", { required: true })] },
      { id: "habit", title: "Habits", fields: [builtIn("is_smoker")] },
      { id: "branch_notes", title: "Branch notes", fields: [added("visit_reason", { type: "select", options: [{ id: "a", label: "Walk-in", value: "Walk-in" }] }),
        added("callback", { type: "checkbox", required: true }), added("callback_time", { show_if: { field: "callback", equals: "Yes" }, required: true })] },
      { id: "empty_new", title: "Empty new section", fields: [] },
    ],
  };
  const s = splitTemplate(content);
  check("a section the form has takes the template's name for its tab", s.tabLabels.demographics === "Who they are" && s.tabLabels.insurance_plan === undefined && TAB_OF_SECTION.habit === "habit_check" && s.tabLabels.habit_check === "Habits", s.tabLabels);
  check("only ADDED fields are drawn, at the bottom of their tab", s.extraByTab.demographics?.map((f) => f.id).join() === "blood_group" && s.extraByTab.habit_check === undefined, s.extraByTab);
  check("a section the form does not have becomes a new tab with its added fields", s.extraTabs.map((t) => t.id).join() === "branch_notes,empty_new" && s.extraTabs[0].fields.length === 3);
  check("a built-in field is never drawn twice", !JSON.stringify(s).includes("first_name") && !JSON.stringify(s).includes("is_smoker"));

  const none = splitTemplate(null);
  check("with no template the form is just the form", Object.keys(none.tabLabels).length === 0 && none.extraTabs.length === 0);

  check("a 'show only if' field is hidden until its condition is met", !isVisible(content.sections[2].fields[2], {}) && !isVisible(content.sections[2].fields[2], { callback: false }) && isVisible(content.sections[2].fields[2], { callback: true }));
  const m0 = missingRequired(content, {}).map((m) => `${m.tab}:${m.field.id}`);
  check("required added fields with no answer are reported with the tab to go to", m0.join() === "demographics:blood_group,tpl:branch_notes:callback", m0);
  const m1 = missingRequired(content, { blood_group: "O+", callback: true }).map((m) => m.field.id);
  check("a field revealed by an answer becomes required, and answered ones are not reported", m1.join() === "callback_time", m1);
  check("an unticked required tick box counts as unanswered", missingRequired(content, { blood_group: "O+", callback: false }).map((m) => m.field.id).join() === "callback");
  check("nothing is reported when everything required is answered", missingRequired(content, { blood_group: "O+", callback: true, callback_time: "5pm" }).length === 0);

  const kept = cleanAnswers(content, { blood_group: "O+", visit_reason: "Walk-in", callback: false, callback_time: "stale", removed_field: "gone" });
  check("only answers of fields that still exist and are visible are saved", JSON.stringify(kept) === JSON.stringify({ blood_group: "O+", visit_reason: "Walk-in", callback: false }), kept);

  // today's live template
  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.TPL_TOKEN}`;
  const live = await getPublished("lead_acquisition");
  const ls = splitTemplate(live.content);
  const drawn = [...Object.values(ls.extraByTab).flat(), ...ls.extraTabs.flatMap((t) => t.fields)];
  check("on the live template the form draws only added fields, never a built-in one", drawn.every((f) => f.binding?.store !== "profile"), drawn.map((f) => f.id));
  check("every section the live template has beyond the form's 8 tabs is drawn as an extra tab", ls.extraTabs.length === live.content.sections.filter((s) => !TAB_OF_SECTION[s.id]).length);
  check("the live template names the form's 8 tabs", Object.keys(ls.tabLabels).length === 8 && ls.tabLabels.demographics === "Identity & Contact" && ls.tabLabels.insurance_plan === "Insurance Plan", ls.tabLabels);

  console.log(`\n${failures === 0 ? "PASS" : "FAILED"}: ${failures} failed`);
  return failures === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error("FAIL unexpected error:", e); process.exit(1); });
