"""
Customer-facing email templates (HTML + plain-text).

Kept separate from the routers so the copy/markup lives in one place. Emails
follow the usual deliverability best-practices: a single 600px table-based
column, all CSS inline, a plain-text fallback, and no external assets.
"""

from __future__ import annotations

import html as _html
from typing import Optional

_BRAND = "#0f766e"   # teal-700, matches the app accent
_BRAND_DARK = "#115e59"
_INK = "#0f172a"
_MUTE = "#64748b"
_BG = "#f1f5f9"
_LINE = "#e2e8f0"


def _pkr(n: Optional[float]) -> str:
    return f"PKR {n:,.0f}" if n is not None else "—"


def credentials_email(
    *,
    full_name: str,
    email: str,
    username: str,
    password: str,
    role_label: str,
    tenant_name: Optional[str] = None,
    login_url: Optional[str] = None,
) -> tuple[str, str, str]:
    """Return (subject, text_body, html_body) for a new-account credentials email.

    Sent to a SuperAdmin (platform bootstrap) or to a tenant Admin / user whose
    account was just provisioned. The generated password is shown in a
    click-to-select field — email clients block JavaScript, so a real "copy"
    button is not possible inside the message; selecting the field is the
    closest equivalent and matches what GitHub / Atlassian / Vercel do.
    """
    scope = f"at {tenant_name}" if tenant_name else "on the insurance-ai platform"
    subject = f"Your insurance-ai {role_label} account is ready"
    article = "An" if role_label[:1].lower() in "aeiou" else "A"

    # ── Plain-text fallback ──────────────────────────────────────────────────
    text = (
        f"Hi {full_name},\n\n"
        f"{article} {role_label} account has been created for you {scope}.\n\n"
        f"  Email:    {email}\n"
        f"  Username: {username}\n"
        f"  Password: {password}\n\n"
        + (f"Sign in: {login_url}\n\n" if login_url else "")
        + "For your security, change this password immediately after your first "
        "sign-in, then delete this email.\n\n"
        "If you weren't expecting this, please contact your administrator.\n\n"
        "— insurance-ai"
    )

    # ── HTML ─────────────────────────────────────────────────────────────────
    e_name = _html.escape(full_name)
    e_email = _html.escape(email)
    e_username = _html.escape(username)
    e_password = _html.escape(password)
    e_scope = _html.escape(scope)

    def _field(label: str, value: str, *, emphasis: bool = False, first: bool = False) -> str:
        border = "" if first else f"border-top:1px solid {_LINE};"
        bg = "background:#f8fafc;" if emphasis else ""
        val_style = (
            f"font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;"
            f"color:{_BRAND_DARK if emphasis else _INK};"
            f"font-size:{'18px' if emphasis else '14px'};"
            f"font-weight:{'700' if emphasis else '600'};"
            f"letter-spacing:{'0.5px' if emphasis else '0'};"
            "-webkit-user-select:all;-moz-user-select:all;user-select:all;word-break:break-all;"
        )
        return (
            f'<tr><td style="padding:14px 18px;{border}{bg}">'
            f'<div style="color:{_MUTE};font-size:11px;font-weight:600;text-transform:uppercase;'
            f'letter-spacing:0.6px;margin-bottom:5px;">{label}</div>'
            f'<div style="{val_style}">{value}</div>'
            f'</td></tr>'
        )

    fields = (
        _field("Email", e_email, first=True)
        + _field("Username", e_username)
        + _field("Temporary password", e_password, emphasis=True)
    )

    sign_in_button = (
        f'<div style="text-align:center;margin:26px 0 6px;">'
        f'<a href="{_html.escape(login_url)}" style="display:inline-block;background:{_BRAND};'
        f'color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;'
        f'padding:13px 30px;border-radius:8px;">Sign in to your account</a>'
        f'</div>'
        if login_url else ""
    )

    html = f"""\
<!doctype html><html><body style="margin:0;padding:0;background:{_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_BG};padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;">
    <tr><td style="background:{_BRAND};padding:24px 28px;">
      <div style="color:#ffffff;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;opacity:.8;">insurance-ai</div>
      <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">Your {_html.escape(role_label)} account is ready</div>
    </td></tr>
    <tr><td style="padding:28px;">
      <p style="color:{_INK};font-size:15px;margin:0 0 12px;">Hi {e_name},</p>
      <p style="color:{_INK};font-size:14px;line-height:22px;margin:0 0 22px;">
        {article} <b>{_html.escape(role_label)}</b> account has been created for you {e_scope}.
        Use the credentials below to sign in for the first time.
      </p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="border:1px solid {_LINE};border-radius:12px;overflow:hidden;margin:0 0 4px;">
        {fields}
      </table>
      <p style="color:{_MUTE};font-size:11px;line-height:16px;margin:8px 2px 0;">
        Tip: triple-click the password to select it, then copy.
      </p>

      {sign_in_button}

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
        <tr><td style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 16px;">
          <div style="color:#92400e;font-size:13px;font-weight:700;margin-bottom:4px;">Keep this secure</div>
          <p style="color:#92400e;font-size:12px;line-height:18px;margin:0;">
            Change your password immediately after signing in, then delete this email.
            Never share these credentials with anyone.
          </p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:18px 28px;border-top:1px solid {_LINE};">
      <div style="color:{_MUTE};font-size:11px;line-height:17px;">
        You're receiving this because an administrator created an insurance-ai account for this
        email address. If you weren't expecting it, please contact your administrator.
      </div>
      <div style="color:{_MUTE};font-size:11px;margin-top:8px;">This is a system-generated message — please do not reply.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>"""

    return subject, text, html


def issuance_email(
    *,
    customer_name: str,
    tenant_name: str,
    policy_number: str,
    product_name: str,
    sum_assured: Optional[float],
    premium: Optional[float],
    billing_frequency: str,
    effective_date: Optional[str],
    maturity_date: Optional[str],
    free_look_end_date: Optional[str],
    policyholder_id: Optional[str],
    portal_url: Optional[str],
    tenant_phone: Optional[str],
    tenant_email: Optional[str],
) -> tuple[str, str, str]:
    """Return (subject, text_body, html_body) for the policy-issuance confirmation."""
    subject = f"Your {tenant_name} policy {policy_number} is now active"

    rows = [
        ("Policy Number", policy_number),
        ("Product", product_name),
        ("Sum Assured", _pkr(sum_assured)),
        ("Premium", f"{_pkr(premium)} ({billing_frequency})"),
        ("Commencement Date", effective_date or "—"),
        ("Maturity Date", maturity_date or "—"),
    ]
    if policyholder_id:
        rows.insert(1, ("Policyholder ID", policyholder_id))
    if free_look_end_date:
        rows.append(("Free-Look Until", free_look_end_date))

    # ── Plain-text fallback ───────────────────────────────────────────────────
    text = (
        f"Dear {customer_name},\n\n"
        f"Congratulations — your {product_name} policy with {tenant_name} is now active.\n\n"
        + "\n".join(f"  {k}: {v}" for k, v in rows)
        + "\n\n"
        + (f"Manage your policy and download documents in the customer portal: {portal_url}\n\n" if portal_url else "")
        + "Thank you for choosing us to protect what matters.\n"
        f"{tenant_name}\n"
        + (f"UAN: {tenant_phone}  " if tenant_phone else "")
        + (f"Email: {tenant_email}" if tenant_email else "")
    )

    # ── HTML ─────────────────────────────────────────────────────────────────
    detail_rows = "".join(
        f'<tr>'
        f'<td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:{_MUTE};font-size:13px;">{k}</td>'
        f'<td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:{_INK};font-size:13px;font-weight:600;text-align:right;">{v}</td>'
        f'</tr>'
        for k, v in rows
    )
    contact_bits = "  ·  ".join(
        b for b in [f"UAN: {tenant_phone}" if tenant_phone else "", f"Email: {tenant_email}" if tenant_email else ""] if b
    )
    portal_button = (
        f'<a href="{portal_url}" style="display:inline-block;background:{_BRAND};color:#ffffff;'
        f'text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:8px;">'
        f'Go to Customer Portal</a>'
        if portal_url else ""
    )

    html = f"""\
<!doctype html><html><body style="margin:0;padding:0;background:{_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_BG};padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
    <tr><td style="background:{_BRAND};padding:22px 28px;">
      <div style="color:#ffffff;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:.85;">{tenant_name}</div>
      <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:4px;">Your policy is active</div>
    </td></tr>
    <tr><td style="padding:28px;">
      <p style="color:{_INK};font-size:15px;margin:0 0 12px;">Dear {customer_name},</p>
      <p style="color:{_INK};font-size:14px;line-height:22px;margin:0 0 18px;">
        Congratulations — your <b>{product_name}</b> policy with {tenant_name} has been issued and your cover is now
        in force. Below is a summary of your policy for your records.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">{detail_rows}</table>

      {f'<div style="text-align:center;margin:0 0 22px;">{portal_button}</div>' if portal_button else ''}

      <p style="color:{_MUTE};font-size:12px;line-height:18px;margin:0;">
        Please keep your policy documents safe. If any detail above is incorrect, contact us within the free-look period.
        Thank you for choosing us to protect what matters most.
      </p>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:18px 28px;border-top:1px solid #e2e8f0;">
      <div style="color:{_INK};font-size:13px;font-weight:600;">{tenant_name}</div>
      {f'<div style="color:{_MUTE};font-size:12px;margin-top:4px;">{contact_bits}</div>' if contact_bits else ''}
      <div style="color:{_MUTE};font-size:11px;margin-top:8px;">This is a system-generated confirmation. Please do not reply to this email.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>"""

    return subject, text, html


def endorsement_email(
    *,
    customer_name: str,
    tenant_name: str,
    policy_number: str,
    endorsement_no: str,
    endorsement_type: str,
    summary: str,
    effective_date: str,
    premium_delta: float,
    tenant_phone=None,
    tenant_email=None,
) -> tuple[str, str, str]:
    """Return (subject, text, html) for an endorsement confirmation email."""
    subject = f"Policy endorsement {endorsement_no} — {tenant_name}"
    if abs(premium_delta) < 0.005:
        delta_line = "There is no change to your premium."
    else:
        verb = "increased" if premium_delta > 0 else "decreased"
        delta_line = f"Your annual premium has {verb} by {_pkr(abs(premium_delta))}."

    text = (
        f"Dear {customer_name},\n\n"
        f"An endorsement has been applied to your policy {policy_number}.\n\n"
        f"  Endorsement No.: {endorsement_no}\n"
        f"  Type: {endorsement_type}\n"
        f"  Change: {summary}\n"
        f"  Effective Date: {effective_date}\n\n"
        f"{delta_line}\n\n"
        "This endorsement forms part of your policy contract. All other terms remain unchanged.\n\n"
        f"{tenant_name}\n"
        + (f"UAN: {tenant_phone}  " if tenant_phone else "")
        + (f"Email: {tenant_email}" if tenant_email else "")
    )

    rows = [
        ("Policy Number", policy_number),
        ("Endorsement No.", endorsement_no),
        ("Type", endorsement_type),
        ("Effective Date", effective_date),
    ]
    detail_rows = "".join(
        f'<tr><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:{_MUTE};font-size:13px;">{k}</td>'
        f'<td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:{_INK};font-size:13px;font-weight:600;text-align:right;">{v}</td></tr>'
        for k, v in rows
    )
    contact_bits = "  ·  ".join(b for b in [f"UAN: {tenant_phone}" if tenant_phone else "", f"Email: {tenant_email}" if tenant_email else ""] if b)

    html = f"""\
<!doctype html><html><body style="margin:0;padding:0;background:{_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_BG};padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
    <tr><td style="background:{_BRAND};padding:22px 28px;">
      <div style="color:#ffffff;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:.85;">{tenant_name}</div>
      <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:4px;">Policy endorsement applied</div>
    </td></tr>
    <tr><td style="padding:28px;">
      <p style="color:{_INK};font-size:15px;margin:0 0 12px;">Dear {customer_name},</p>
      <p style="color:{_INK};font-size:14px;line-height:22px;margin:0 0 18px;">
        The following change has been made to your policy and forms part of your contract:
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">{detail_rows}</table>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 16px;margin:0 0 18px;">
        <div style="color:{_BRAND};font-size:13px;font-weight:700;margin-bottom:4px;">Change</div>
        <p style="color:{_INK};font-size:13px;line-height:20px;margin:0 0 6px;">{summary}</p>
        <p style="color:{_INK};font-size:13px;line-height:20px;margin:0;">{delta_line}</p>
      </div>
      <p style="color:{_MUTE};font-size:12px;line-height:18px;margin:0;">All other terms and conditions of your policy remain unchanged. If any detail is incorrect, please contact us promptly.</p>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:18px 28px;border-top:1px solid #e2e8f0;">
      <div style="color:{_INK};font-size:13px;font-weight:600;">{tenant_name}</div>
      {f'<div style="color:{_MUTE};font-size:12px;margin-top:4px;">{contact_bits}</div>' if contact_bits else ''}
      <div style="color:{_MUTE};font-size:11px;margin-top:8px;">This is a system-generated confirmation. Please do not reply to this email.</div>
    </td></tr>
  </table>
</td></tr></table></body></html>"""
    return subject, text, html
