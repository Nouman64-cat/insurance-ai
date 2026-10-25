// Frontend-to-backend integration test of the Templates tab. It runs the page's own module (lib/templates.ts) under node against the live gateway:
// list, open, edit (add / remove / reword / move), refused edits with their reasons, locked fields, save draft, publish with a reason, the new
// published version, history and difference, restore, discard, and refusal without sign-in.
//   python evals/frontend/run_templates_integration.py      (creates a throwaway template first and retires it afterwards)
import api from "@/app/services/api";
import {
  allFieldIds, clone, describeChange, discardDraft, getDiff, getPublished, getTemplate, getVersion, listTemplates, move, newField, publishTemplate, restoreVersion, saveDraft, slugFor,
  type TemplateContent,
} from "@/lib/templates";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
async function rejection(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

async function main(): Promise<number> {
  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.TPL_TOKEN}`;
  const KEY = process.env.TPL_KEY as string;

  // pure editing helpers the editor relies on
  check("a new field id comes from its label and never repeats", slugFor("Blood group", []) === "blood_group" && slugFor("Blood group", ["blood_group"]) === "blood_group_2" && slugFor("123", []).startsWith("f_"));
  check("a new select field starts with options, a table with a column", newField("select", "Marital status", []).options!.length === 2 && newField("table", "Dependants", []).columns!.length === 1);
  check("moving a field changes its place and out-of-range moves do nothing", move([1, 2, 3], 0, 2).join() === "2,3,1" && move([1, 2, 3], 0, -1).join() === "1,2,3");

  const all = await listTemplates();
  const keys = all.map((t) => t.key);
  check("the tab lists the lead form and the proposal, and no retired template", keys.includes("lead_acquisition") && keys.includes("proposal") && !keys.some((k) => k.startsWith("illustration:")), keys);
  check("each template shows its published version and field count", all.every((t) => t.published_version && t.fields > 0));
  check("the test template is listed", keys.includes(KEY));
  const proposal = await getTemplate("proposal");
  const lead = await getTemplate("lead_acquisition");
  const profileSections = lead.published!.content.sections.filter((x) => x.fields.some((f) => f.binding?.store === "profile"));
  const builtIn = profileSections.flatMap((x) => x.fields.filter((f) => f.binding?.store === "profile"));
  check("the lead form still has its 8 original tabs and 49 original fields (sections and fields added since are on top of them)", profileSections.length === 8 && builtIn.length === 49, [profileSections.length, builtIn.length]);
  check("the tabs carry the live names", lead.published!.content.sections.map((s) => s.title).slice(0, 3).join("|") === "Identity & Contact|CNIC & Docs|Occupation & Income");
  check("the proposal carries the live form's questions", allFieldIds(proposal.published!.content).includes("height_cm") && allFieldIds(proposal.published!.content).includes("signature_name") && proposal.published!.content.sections.length === 9);

  const t0 = await getTemplate(KEY);
  check("a template opens with its published content and no draft", t0.published!.version === 1 && t0.draft === null && t0.versions.length === 1);
  const base: TemplateContent = clone(t0.published!.content);

  const noTitle = clone(base); noTitle.title = "";
  const r1 = await rejection(() => saveDraft(KEY, noTitle));
  check("an invalid edit is refused and the message says why", !!r1 && /needs a title/.test(r1), r1);
  const dup = clone(base); dup.sections[1].fields.push(clone(dup.sections[1].fields[0]));
  const r2 = await rejection(() => saveDraft(KEY, dup));
  check("a repeated field id is refused", !!r2 && /used twice/.test(r2), r2);

  // edit: add a field, remove one, reword one, move a section
  const edited = clone(base);
  edited.sections[2].fields.push(newField("text", "Special instructions", allFieldIds(edited)));
  edited.sections[0].fields = edited.sections[0].fields.filter((f) => f.id !== "emergency_contact_name");
  edited.sections[2].title = "Work and income";
  edited.sections = move(edited.sections, 6, 5);
  const saved = await saveDraft(KEY, edited);
  const kinds = new Set(saved.changes.map((c) => `${c.change}:${c.what}`));
  check("saving a draft reports what it changes", kinds.has("added:field:special_instructions") && kinds.has("removed:field:emergency_contact_name") && saved.changes.some((c) => c.what === "section:employment" && c.change === "edited"), Array.from(kinds));
  check("the changes read as plain sentences", saved.changes.map(describeChange).some((s) => s === "Field 'special_instructions' was added"));
  check("a valid draft can be published", saved.publish_problems.length === 0, saved.publish_problems);
  const t1 = await getTemplate(KEY);
  check("the draft is kept and the published version is untouched", t1.draft!.version === 2 && t1.published!.version === 1 && !allFieldIds(t1.published!.content).includes("special_instructions"));
  check("everyone else still reads version 1 until it is published", (await getPublished(KEY)).version === 1);

  // locked fields
  const dropLocked = clone(edited); dropLocked.sections[0].fields = dropLocked.sections[0].fields.filter((f) => f.id !== "first_name");
  const withProblems = await saveDraft(KEY, dropLocked);
  check("a draft that drops a locked field is saved but reported as not publishable", withProblems.publish_problems.some((p) => p.includes("first_name") && p.includes("locked")), withProblems.publish_problems);
  const r3 = await rejection(() => publishTemplate(KEY, "removing the plan name"));
  check("publishing it is refused and the reason names the field", !!r3 && /first_name/.test(r3) && /locked/.test(r3), r3);
  const r3b = await rejection(() => publishTemplate(KEY, "  "));
  check("publishing without a written reason is refused", r3b !== null, r3b);

  // publish
  await saveDraft(KEY, edited);
  const pub = await publishTemplate(KEY, "Added a special instructions field and removed the insurer line");
  check("publishing creates the next version with the person's reason", pub.published.version === 2 && pub.published.change_note!.startsWith("Added a special"), pub.published);
  check("the change was handed to the evaluation team's change registry", pub.registry.recorded === true, pub.registry);
  check("the publish lists what changed", pub.changes.length >= 3);
  const live = await getPublished(KEY);
  check("the new version is now what everyone reads", live.version === 2 && allFieldIds(live.content).includes("special_instructions") && !allFieldIds(live.content).includes("emergency_contact_name"));
  const list2 = (await listTemplates()).find((t) => t.key === KEY)!;
  check("the list shows the new version and no draft", list2.published_version === 2 && !list2.has_draft);

  // history
  const t2 = await getTemplate(KEY);
  check("history shows both versions, the old one superseded", t2.versions.map((v) => `${v.version}:${v.state}`).join() === "2:published,1:superseded", t2.versions);
  const diff = await getDiff(KEY, 1, 2);
  check("the difference between versions 1 and 2 is available", diff.changes.some((c) => c.what === "field:special_instructions" && c.change === "added"));
  check("an old version can still be opened", (await getVersion(KEY, 1)).content.sections.length === base.sections.length);

  // restore and discard
  const restored = await restoreVersion(KEY, 1);
  check("an older version can be restored into the draft without publishing it", restored.draft.version === 3 && (await getPublished(KEY)).version === 2);
  const back = await getDiff(KEY, 2, "draft");
  check("the draft shows what restoring would change", back.changes.some((c) => c.what === "field:special_instructions" && c.change === "removed"));
  check("a draft can be discarded", (await discardDraft(KEY)).discarded === true && (await getTemplate(KEY)).draft === null);

  // no sign-in
  const saved2 = api.defaults.headers.common["Authorization"];
  delete api.defaults.headers.common["Authorization"];
  const noAuth = await rejection(() => listTemplates());
  api.defaults.headers.common["Authorization"] = saved2;
  check("without signing in the tab's calls are refused", noAuth !== null, noAuth);

  console.log(`\n${failures === 0 ? "PASS" : "FAILED"}: ${failures} failed`);
  return failures === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error("FAIL unexpected error:", e); process.exit(1); });
