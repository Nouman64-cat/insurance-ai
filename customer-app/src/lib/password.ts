// Mirrors customer-portal/components/PasswordRules.tsx. The backend enforces the real policy; this only guides the user.
export function passwordChecks(pw: string, username = '') {
  return [
    { key: 'length', label: 'At least 10 characters', ok: pw.length >= 10 },
    { key: 'mix', label: 'Contains letters and numbers', ok: /[A-Za-z]/.test(pw) && /\d/.test(pw) },
    { key: 'username', label: 'Does not contain your username', ok: !username || !pw.toLowerCase().includes(username.toLowerCase()) },
  ];
}
