"""Group Life PDFs — the corporate quote and the master policy schedule.

Same reportlab look as services/document_generator.py (whose layout helpers
these reuse). Files land under MEDIA_ROOT/group/<master_policy_id>/ and are
served by routers/group_policies.py. Takaful schemes say "contribution"
where conventional ones say "premium".
"""

from __future__ import annotations

import os
from datetime import date

from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, Spacer, Table, TableStyle

from services.document_generator import MEDIA_ROOT, _build, _card_table, _footer, _header, _pkr, _styles


def _dir(master_policy_id: str) -> str:
    path = os.path.join(MEDIA_ROOT, "group", str(master_policy_id))
    os.makedirs(path, exist_ok=True)
    return path


def _premium_word(business_type: str) -> str:
    return "Contribution" if business_type == "Takaful" else "Premium"


def _grid(header: list[str], rows: list[list[str]], widths: list[float]) -> Table:
    ss = _styles()
    data = [[Paragraph(f"<b>{h}</b>", ss["Body"]) for h in header]]
    data += [[Paragraph(str(c), ss["Body"]) for c in r] for r in rows]
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eff6ff")),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def generate_group_quote(ctx: dict) -> str:
    """ctx: tenant_name, organization, plan_label, business_type, master_policy_id,
    quote (GroupQuote-like dict), effective_date. Returns the file path."""
    ss = _styles()
    q = ctx["quote"]
    word = _premium_word(ctx["business_type"])
    b = q["breakdown"]
    renewal = ctx.get("renewal")
    story = _header(ss, ctx["tenant_name"], f"{ctx['plan_label']} — {'Renewal ' if renewal else ''}Quotation",
                    f"Quote v{q['version']} for {ctx['organization']} · valid until {q['valid_until']}")
    story.append(_card_table([
        ("Policyholder", ctx["organization"]),
        ("Product", f"{ctx['plan_label']} ({ctx['business_type']})"),
        *([("Renewal period", f"{renewal['new_period_start']} to {renewal['new_period_end']}")] if renewal else []),
        ("Proposed start" if not renewal else "Renewing from", str(ctx["effective_date"])),
        ("Insured members", f"{q['member_count']:,}" + (f" + {q['dependent_count']:,} covered dependants" if q["dependent_count"] else "")),
        ("Total sum assured", _pkr(q["total_sum_assured"])),
    ], "Scheme"))
    story.append(Spacer(1, 8))
    story.append(Paragraph("Rating", ss["H"]))
    story.append(_card_table([
        ("Base rate", f"PKR {b['base_rate_per_mille']:g} per 1,000 sum assured"),
        ("Average age (SA-weighted)", f"{b['weighted_average_age']:g} → factor {b['age_factor']:g}x"),
        ("Group size factor", f"{b['size_factor']:g}x"),
        ("Occupational hazard factor", f"{b['hazard_factor']:g}x"),
        *([("Experience factor", f"{b['experience_factor']:g}x")] if b.get("experience_factor", 1.0) != 1.0 else []),
        ("Effective rate", f"PKR {q['rate_per_mille']:g} per 1,000 sum assured"),
    ]))
    if renewal:
        x = renewal["experience"]
        story.append(Paragraph("Experience of the expiring period", ss["H"]))
        story.append(_card_table([
            (f"{word} earned to date", _pkr(x["premium_earned"])),
            ("Claims incurred", f"{_pkr(x['claims_incurred'])} ({x['claim_count']} claim{'s' if x['claim_count'] != 1 else ''})"),
            ("Loss ratio", f"{x['claims_ratio'] * 100:.1f}% (target {x['target_loss_ratio'] * 100:.0f}%)"),
            ("Credibility of the group", f"{x['credibility'] * 100:.0f}%"),
            ("<b>Experience factor on the rate</b>", f"<b>{renewal['experience_factor']:g}x</b>"),
        ]))
    story.append(Paragraph("By benefit class", ss["H"]))
    story.append(_grid(
        ["Class", "Members", "Dependants", "Sum assured", word],
        [[c["benefit_class"], c["members"], c["dependents"], _pkr(c["sum_assured"]), _pkr(c["premium"])] for c in b["by_class"]],
        [45, 22, 25, 38, 36],
    ))
    if len(b.get("by_coverage") or {}) > 1:
        names = {"Life": "Life", "AccidentalDeath": "Accidental Death", "Disability": "Disability",
                 "PayContinuation": "Pay Continuation", "FeeContinuation": "Fee Continuation"}
        story.append(Paragraph("By benefit", ss["H"]))
        story.append(_grid(
            ["Benefit", "Total cover", word],
            [[names.get(k, k), _pkr(b["cover_by_coverage"].get(k, 0)), _pkr(v)] for k, v in b["by_coverage"].items()],
            [70, 48, 48],
        ))
    if b.get("adjusted_members"):
        story.append(Paragraph("Underwriting adjustments", ss["H"]))
        story.append(_grid(
            ["Member", "Basis", "Cover", "Note"],
            [[m["name"], m["basis"], _pkr(m["covered_amount"]), m.get("note") or (f"+{m['loading_pct']:g}% loading" if m.get("loading_pct") else "")]
             for m in b["adjusted_members"]],
            [45, 25, 35, 61],
        ))
    story.append(KeepTogether([
        Paragraph(f"Annual {word.lower()}", ss["H"]),
        _card_table([
            (f"Risk {word.lower()}", _pkr(q["risk_premium"])),
            ("Policy fee", _pkr(q["policy_fee"])),
            ("Stamp duty", _pkr(q["stamp_duty"])),
            (f"<b>Total annual {word.lower()}</b>", f"<b>{_pkr(q['total_premium'])}</b>"),
        ]),
    ]))
    if b.get("takaful"):
        t = b["takaful"]
        story.append(KeepTogether([
            Paragraph("Contribution allocation", ss["H"]),
            _card_table([
                (f"Wakala fee ({t['wakala_fee_pct']:g}% of risk contribution)", _pkr(t["wakala_fee"])),
                ("Participants' Takaful Fund (PTF)", _pkr(t["ptf_allocation"])),
                *([(f"  of which ceded to retakaful ({t['retakaful_share_pct']:g}%)", _pkr(t["retakaful_contribution"])),
                   ("  retained by the PTF for claims", _pkr(t["ptf_retained"]))] if t.get("retakaful_share_pct") else []),
            ]),
        ]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "This quotation is based on the member census supplied by the policyholder and is valid until the date "
        "shown. Cover above the Free Cover Limit is subject to the underwriting outcomes listed. Members joining or "
        "leaving after issuance are adjusted by endorsement.", ss["Fine"]))
    story += _footer(ss)

    path = os.path.join(_dir(ctx["master_policy_id"]), f"quote_v{q['version']}.pdf")
    _build(path, story)
    return path


def generate_master_schedule(ctx: dict) -> str:
    """ctx: tenant_name, organization, plan_label, business_type, master_policy_id,
    policy_number, effective_date, expiry_date, total_premium, free_cover_limit,
    classes [{name, basis_text}], members [{certificate, name, cnic, class, cover, note}],
    dependents [{member, name, relationship, cover}], optional takaful {wakala_fee_pct,
    wakala_fee, ptf_allocation}. Returns the file path."""
    ss = _styles()
    word = _premium_word(ctx["business_type"])
    story = _header(ss, ctx["tenant_name"], f"{ctx['plan_label']} — Policy Schedule",
                    f"Master Policy {ctx['policy_number']} · {ctx['organization']}")
    story.append(_card_table([
        ("Master policy no.", ctx["policy_number"]),
        ("Policyholder", ctx["organization"]),
        ("Product", f"{ctx['plan_label']} ({ctx['business_type']})"),
        ("Period of cover", f"{ctx['effective_date']} to {ctx['expiry_date']} (renewable annually)"),
        ("Free Cover Limit", _pkr(ctx["free_cover_limit"])),
        (f"Annual {word.lower()}", _pkr(ctx["total_premium"])),
        *([
            (f"Wakala fee ({ctx['takaful']['wakala_fee_pct']:g}%)", _pkr(ctx["takaful"]["wakala_fee"])),
            ("Participants' Takaful Fund (PTF)", _pkr(ctx["takaful"]["ptf_allocation"])),
            *([(f"Retakaful contribution ({ctx['takaful']['retakaful_share_pct']:g}% of PTF)", _pkr(ctx["takaful"]["retakaful_contribution"]))]
              if ctx["takaful"].get("retakaful_share_pct") else []),
        ] if ctx.get("takaful") else []),
        ("Insured members", f"{len(ctx['members']):,}"),
    ], "Schedule"))
    if ctx["classes"]:
        story.append(Paragraph("Benefit classes", ss["H"]))
        story.append(_grid(["Class", "Benefit"], [[c["name"], c["basis_text"]] for c in ctx["classes"]], [45, 121]))
    story.append(Paragraph("Schedule of insured members", ss["H"]))
    story.append(_grid(
        ["Certificate", "Name", "CNIC", "Class", "Sum assured"],
        [[m["certificate"], m["name"], m["cnic"] or "—", m["class"] or "—",
          _pkr(m["cover"]) + (f"<br/><font size=7>{m['note']}</font>" if m.get("note") else "")]
         for m in ctx["members"]],
        [36, 40, 32, 24, 34],
    ))
    if ctx["dependents"]:
        story.append(Paragraph("Covered dependants", ss["H"]))
        story.append(Paragraph(
            "Only the dependants listed below are insured. Nominees/beneficiaries are not covered lives.", ss["Fine"]))
        story.append(_grid(["Member", "Dependant", "Relationship", "Sum assured"],
                           [[d["member"], d["name"], d["relationship"], _pkr(d["cover"])] for d in ctx["dependents"]],
                           [45, 45, 36, 40]))
    story += _footer(ss)

    path = os.path.join(_dir(ctx["master_policy_id"]), f"schedule_{date.today().isoformat()}.pdf")
    _build(path, story)
    return path


def generate_group_endorsement(ctx: dict) -> str:
    """ctx: tenant_name, organization, plan_label, business_type, master_policy_id,
    policy_number, endorsement {number, endorsement_type, status, effective_date, reason,
    days_remaining, period_days, pro_rata_factor, member_count_delta, sum_assured_delta,
    risk_delta, stamp_duty_delta, premium_delta, wakala_fee_delta, ptf_delta, lines}.
    Returns the file path."""
    ss = _styles()
    e = ctx["endorsement"]
    word = _premium_word(ctx["business_type"])
    kind = {"ADD": "Addition of members", "DELETE": "Deletion of members", "CHANGE": "Change to member cover"}[e["endorsement_type"]]
    story = _header(ss, ctx["tenant_name"], f"Endorsement {e['number']}",
                    f"{kind} · Master Policy {ctx['policy_number']} · {ctx['organization']}")
    story.append(_card_table([
        ("Endorsement no.", e["number"]),
        ("Master policy", f"{ctx['policy_number']} — {ctx['plan_label']} ({ctx['business_type']})"),
        ("Policyholder", ctx["organization"]),
        ("Type", kind),
        ("Effective date", str(e["effective_date"])),
        ("Reason", e.get("reason") or "—"),
        ("Status", e["status"]),
    ], "Endorsement"))
    story.append(Paragraph("Members affected", ss["H"]))
    rows = []
    for ln in e["lines"]:
        before, after = ln.get("before") or {}, ln.get("after") or {}
        cover = (_pkr(before["cover"]) + " → " if before.get("cover") is not None and ln["action"] == "CHANGE" else "") \
            + (_pkr(after["cover"]) if after.get("cover") is not None else (_pkr(before["cover"]) if before.get("cover") is not None else "—"))
        rows.append([ln["action"], ln["name"], ln.get("certificate_number") or "—", cover,
                     _pkr(ln.get("risk_delta") or 0), ln.get("status") + (f"<br/><font size=7>{ln['note']}</font>" if ln.get("note") else "")])
    story.append(_grid(["Action", "Member", "Certificate", "Sum assured", f"Pro-rata {word.lower()}", "Status"], rows,
                       [16, 38, 30, 34, 26, 22]))
    story.append(Spacer(1, 6))
    story.append(KeepTogether([
        Paragraph(f"{word} adjustment", ss["H"]),
        _card_table([
            ("Pro-rata basis", f"{e['days_remaining']} of {e['period_days']} days ({e['pro_rata_factor'] * 100:.1f}%)"),
            ("Members", f"{e['member_count_delta']:+d}"),
            ("Sum assured", ("+" if e["sum_assured_delta"] >= 0 else "−") + _pkr(abs(e["sum_assured_delta"]))),
            (f"Risk {word.lower()}", ("+" if e["risk_delta"] >= 0 else "−") + _pkr(abs(e["risk_delta"]))),
            ("Stamp duty", ("+" if e["stamp_duty_delta"] >= 0 else "−") + _pkr(abs(e["stamp_duty_delta"]))),
            *([("Wakala fee", ("+" if e["wakala_fee_delta"] >= 0 else "−") + _pkr(abs(e["wakala_fee_delta"]))),
               ("Participants' Takaful Fund (PTF)", ("+" if e["ptf_delta"] >= 0 else "−") + _pkr(abs(e["ptf_delta"])))]
              if e.get("wakala_fee_delta") is not None else []),
            *([("  of which retakaful", ("+" if e["retakaful_delta"] >= 0 else "−") + _pkr(abs(e["retakaful_delta"])))]
              if e.get("retakaful_delta") is not None else []),
            (f"<b>{'Additional' if e['premium_delta'] >= 0 else 'Refund of'} {word.lower()}</b>",
             f"<b>{_pkr(abs(e['premium_delta']))}</b>"),
        ]),
    ]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "This endorsement amends the master policy from the effective date shown and forms part of it. "
        "Cover for added members begins on that date, subject to the underwriting outcomes listed; cover for deleted "
        "members ends on it. The adjustment is calculated pro rata for the unexpired period.", ss["Fine"]))
    story += _footer(ss)

    path = os.path.join(_dir(ctx["master_policy_id"]), f"endorsement_{e['number']}.pdf")
    _build(path, story)
    return path
