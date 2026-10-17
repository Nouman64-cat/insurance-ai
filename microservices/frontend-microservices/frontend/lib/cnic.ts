// Pakistani CNIC: 5 digits - 7 digits - 1 digit (e.g. 35201-1234567-1)
export const CNIC_MAX_DIGITS = 13;
export const CNIC_PATTERN = "\\d{5}-\\d{7}-\\d{1}";

export function formatCnic(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, CNIC_MAX_DIGITS);
  const part1 = digits.slice(0, 5);
  const part2 = digits.slice(5, 12);
  const part3 = digits.slice(12, 13);
  return [part1, part2, part3].filter(Boolean).join("-");
}
