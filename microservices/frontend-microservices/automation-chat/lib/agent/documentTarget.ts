/** Keep document actions bound to the application named in the response. */
export interface UploadTarget {
  case_id?: string;
  case_number?: string;
  cnic?: string;
  applicant_name?: string;
}
export function uploadTargetFromText(message: string): UploadTarget | null {
  const refs = Array.from(new Set((message.match(/\b(?:APP|CASE)-\d{4}-[A-Z0-9]+\b/gi) ?? []).map(r => r.toUpperCase())));
  if (refs.length === 1) return { case_number: refs[0] };
  if (refs.length > 1) return null;
  const cnics = Array.from(new Set(message.match(/\b\d{5}-\d{7}-\d\b/g) ?? []));
  return cnics.length === 1 ? { cnic: cnics[0] } : null;
}
const ref = (s: unknown) => String(s ?? '').trim().toUpperCase().replace(/^CASE-/, 'APP-');
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
export function resolveUploadCase(cases: any[], target: UploadTarget): any {
  let found: any[];
  if (target.case_id) found = cases.filter(c => String(c.caseld ?? c.case_id ?? c.id) === target.case_id);
  else if (target.case_number) found = cases.filter(c => ref(c.caseNumber ?? c.case_number) === ref(target.case_number));
  else if (target.cnic) found = cases.filter(c => digits(c.customer_cnic ?? c.cnic) === digits(target.cnic));
  else if (target.applicant_name) {
    const name = target.applicant_name.trim().toLowerCase();
    found = cases.filter(c => [c.applicant_name, c.customer_name].some(n => typeof n === 'string' && n.trim().toLowerCase() === name));
  } else throw new Error('This upload does not identify an application. Open its requirements and upload the report there.');
  if (!found.length) throw new Error(`Application ${target.case_number ?? ''} could not be found or is not accessible. Refresh its requirements and try again.`);
  if (found.length > 1) throw new Error('More than one application matches. Use the application reference to select the correct one.');
  return found[0];
}
