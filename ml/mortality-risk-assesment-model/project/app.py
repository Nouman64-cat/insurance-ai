"""
app.py  —  Life Insurance Mortality Risk Underwriting App
Run with:  streamlit run app.py
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

import streamlit as st
import pandas as pd
import numpy as np
import plotly.graph_objects as go
from inference import MortalityRiskPredictor, ApplicantProfile

# ── Page config ────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="InsureIQ — Mortality Risk Assessment",
    page_icon="🛡️",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Custom CSS ─────────────────────────────────────────────────────────────
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

html, body, [class*="css"] {
    font-family: 'Inter', sans-serif;
}

.main { background: #0a0d14; }

/* Hero header */
.hero {
    background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
    border-radius: 16px;
    padding: 32px 40px;
    margin-bottom: 28px;
    border: 1px solid #1e3a4a;
}
.hero h1 { color: #ffffff; font-size: 2.1rem; font-weight: 700; margin: 0; }
.hero p  { color: #94a3b8; font-size: 1.05rem; margin: 8px 0 0; }

/* Section cards */
.section-card {
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 12px;
    padding: 20px 24px;
    margin-bottom: 16px;
}
.section-title {
    color: #60a5fa;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid #1f2937;
}

/* Risk result card */
.result-card {
    border-radius: 16px;
    padding: 28px 32px;
    text-align: center;
    margin-bottom: 16px;
}
.result-low      { background: linear-gradient(135deg, #052e16, #14532d); border: 1px solid #16a34a; }
.result-moderate { background: linear-gradient(135deg, #422006, #713f12); border: 1px solid #d97706; }
.result-elevated { background: linear-gradient(135deg, #431407, #7c2d12); border: 1px solid #ea580c; }
.result-high     { background: linear-gradient(135deg, #3b0764, #7f1d1d); border: 1px solid #dc2626; }

.result-prob { font-size: 3.6rem; font-weight: 700; color: #ffffff; line-height: 1; }
.result-tier { font-size: 1.4rem; font-weight: 600; margin: 8px 0; }
.result-advice { color: #cbd5e1; font-size: 0.95rem; margin-top: 10px; }

/* Metric chips */
.metric-row { display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.metric-chip {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 10px 16px;
    flex: 1;
    min-width: 120px;
    text-align: center;
}
.metric-chip .val { font-size: 1.4rem; font-weight: 600; color: #f1f5f9; }
.metric-chip .lbl { font-size: 0.75rem; color: #64748b; margin-top: 2px; }

/* Warning box */
.caveat-box {
    background: #1c1f2a;
    border-left: 3px solid #f59e0b;
    border-radius: 0 8px 8px 0;
    padding: 12px 16px;
    margin-top: 16px;
    color: #94a3b8;
    font-size: 0.85rem;
}

stButton button {
    background: linear-gradient(135deg, #3b82f6, #6366f1) !important;
    color: white !important;
    border: none !important;
    border-radius: 10px !important;
    padding: 12px 28px !important;
    font-weight: 600 !important;
    font-size: 1rem !important;
    width: 100%;
}
</style>
""", unsafe_allow_html=True)

# ── Helpers ────────────────────────────────────────────────────────────────
TIER_COLOR = {
    'LOW':      ('#22c55e', 'result-low'),
    'MODERATE': ('#f59e0b', 'result-moderate'),
    'ELEVATED': ('#f97316', 'result-elevated'),
    'HIGH':     ('#ef4444', 'result-high'),
}

def make_gauge(prob: float, tier: str):
    color, _ = TIER_COLOR.get(tier, ('#94a3b8', ''))
    fig = go.Figure(go.Indicator(
        mode="gauge+number",
        value=round(prob * 100, 1),
        number={'suffix': '%', 'font': {'size': 42, 'color': '#f1f5f9'}},
        gauge={
            'axis': {'range': [0, 100], 'tickcolor': '#475569',
                     'tickfont': {'color': '#94a3b8', 'size': 11}},
            'bar':  {'color': color, 'thickness': 0.28},
            'bgcolor': '#1e293b',
            'borderwidth': 0,
            'steps': [
                {'range': [0,  5],  'color': '#052e16'},
                {'range': [5,  15], 'color': '#422006'},
                {'range': [15, 35], 'color': '#431407'},
                {'range': [35, 100],'color': '#3b0764'},
            ],
            'threshold': {
                'line': {'color': color, 'width': 3},
                'thickness': 0.85,
                'value': prob * 100,
            },
        },
    ))
    fig.update_layout(
        height=230, margin=dict(l=20, r=20, t=20, b=10),
        paper_bgcolor='rgba(0,0,0,0)', plot_bgcolor='rgba(0,0,0,0)',
        font={'color': '#f1f5f9'},
    )
    return fig


# ══════════════════════════════════════════════════════════════════════════
# LAYOUT
# ══════════════════════════════════════════════════════════════════════════

# Hero
st.markdown("""
<div class="hero">
  <h1>🛡️ InsureIQ — Mortality Risk Underwriting</h1>
  <p>AI-powered mortality risk assessment for life insurance underwriting · Trained on RAND HRS (45,234 respondents · 1992–2022)</p>
</div>
""", unsafe_allow_html=True)

# ── Sidebar: model config ─────────────────────────────────────────────────
with st.sidebar:
    st.markdown("## ⚙️ Model Settings")
    horizon = st.selectbox(
        "Prediction Horizon",
        options=["5yr", "10yr"],
        format_func=lambda x: "5-Year Mortality" if x == "5yr" else "10-Year Mortality",
        help="How far ahead to predict mortality risk."
    )
    model_choice = st.selectbox(
        "Model",
        options=["xgboost", "logreg"],
        format_func=lambda x: "XGBoost (Best AUROC)" if x == "xgboost" else "Logistic Regression (Explainable)",
        help="XGBoost: best raw performance. LogReg: interpretable for regulators."
    )
    st.markdown("---")
    st.markdown("**Model Performance**")
    perf = {
        ("xgboost", "5yr"):  dict(auroc="0.862", auprc="0.452"),
        ("xgboost", "10yr"): dict(auroc="0.871", auprc="0.728"),
        ("logreg",  "5yr"):  dict(auroc="0.866", auprc="0.440"),
        ("logreg",  "10yr"): dict(auroc="0.863", auprc="0.711"),
    }
    p = perf[(model_choice, horizon)]
    st.metric("AUROC (test set)", p["auroc"])
    st.metric("AUPRC (test set)", p["auprc"])
    st.markdown("---")
    st.caption("⚠️ Prototype only. Not validated for production underwriting.")

# ── Input form ────────────────────────────────────────────────────────────
col_form, col_result = st.columns([1.1, 0.9], gap="large")

with col_form:
    with st.form("applicant_form"):

        # Demographic
        st.markdown('<div class="section-card"><div class="section-title">👤 Demographic</div>', unsafe_allow_html=True)
        c1, c2, c3 = st.columns(3)
        gender    = c1.selectbox("Gender", [1, 2], format_func=lambda x: "Male" if x == 1 else "Female")
        birth_yr  = c2.number_input("Birth Year", min_value=1920, max_value=2000, value=1955, step=1)
        demo_age  = c3.number_input("Age at Application", min_value=30, max_value=95, value=65, step=1, format="%d")

        c4, c5, c6 = st.columns(3)
        hispan = c4.selectbox("Hispanic", [0, 1], format_func=lambda x: "No" if x == 0 else "Yes")
        demo_mstat = c5.selectbox("Marital Status", [1, 2, 3, 4, 5, 7],
            format_func=lambda x: {1:"Married",2:"Partnered",3:"Separated",4:"Divorced",5:"Widowed",7:"Never Married"}[x])
        demo_region = c6.selectbox("Census Region", [1, 2, 3, 4],
            format_func=lambda x: {1:"Northeast",2:"Midwest",3:"South",4:"West"}[x])
        st.markdown('</div>', unsafe_allow_html=True)

        # Education & Financials
        st.markdown('<div class="section-card"><div class="section-title">🎓 Education & 💰 Financials</div>', unsafe_allow_html=True)
        c1, c2 = st.columns(2)
        educ = c1.slider("Years of Education", 0, 17, 12)
        fin_income = c2.number_input("Household Income (USD/yr)", 0, 2_000_000, 60_000, step=1000)

        c3, c4 = st.columns(2)
        fin_wealth = c3.number_input("Total Net Wealth (USD)", -500_000, 10_000_000, 250_000, step=5000)
        fin_wealth_liquid = c4.number_input("Liquid Assets (USD)", 0, 5_000_000, 50_000, step=1000)

        c5, c6 = st.columns(2)
        fin_home_eq = c5.number_input("Home Equity (USD)", 0, 5_000_000, 150_000, step=5000)
        fin_pension = c6.number_input("Pension Value (USD)", 0, 5_000_000, 80_000, step=5000)
        st.markdown('</div>', unsafe_allow_html=True)

        # Health
        st.markdown('<div class="section-card"><div class="section-title">🩺 Health Status</div>', unsafe_allow_html=True)
        c1, c2, c3 = st.columns(3)
        hlth_srh = c1.select_slider(
            "Self-Rated Health",
            options=[1, 2, 3, 4, 5],
            value=3,
            format_func=lambda x: {1:"Excellent",2:"Very Good",3:"Good",4:"Fair",5:"Poor"}[x]
        )
        hlth_bmi = c2.number_input("BMI (kg/m²)", 12.0, 70.0, 26.5, step=0.5)
        hlth_adl5a = c3.slider("ADL Difficulties (0–5)", 0, 5, 0)

        c4, c5, c6 = st.columns(3)
        hlth_smoken = c4.selectbox("Current Smoker", [0, 1], format_func=lambda x: "No" if x == 0 else "Yes")
        hlth_smokev = c5.selectbox("Ever Smoked", [0, 1], format_func=lambda x: "No" if x == 0 else "Yes")
        hlth_iadl5a = c6.slider("IADL Difficulties (0–5)", 0, 5, 0)
        st.markdown('</div>', unsafe_allow_html=True)

        # Conditions
        st.markdown('<div class="section-card"><div class="section-title">🏥 Chronic Conditions (Ever Diagnosed)</div>', unsafe_allow_html=True)
        cc1, cc2, cc3 = st.columns(3)
        cond_hearte = int(cc1.checkbox("❤️ Heart Disease"))
        cond_diabe  = int(cc1.checkbox("🩸 Diabetes"))
        cond_cancre = int(cc2.checkbox("🎗️ Cancer"))
        cond_stroke = int(cc2.checkbox("🧠 Stroke / TIA"))
        cond_hibpe  = int(cc3.checkbox("🔴 Hypertension"))
        cond_lunge  = int(cc3.checkbox("💨 Lung Disease"))
        st.markdown('</div>', unsafe_allow_html=True)

        submitted = st.form_submit_button("🔍 Assess Mortality Risk", use_container_width=True)

# ── Result panel ──────────────────────────────────────────────────────────
with col_result:
    if submitted:
        try:
            applicant = ApplicantProfile(
                gender=gender, birth_yr=birth_yr, demo_age=float(demo_age),
                hispan=hispan, demo_mstat=demo_mstat, demo_region=demo_region,
                educ=educ,
                fin_income=float(fin_income), fin_wealth=float(fin_wealth),
                fin_wealth_liquid=float(fin_wealth_liquid),
                fin_home_eq=float(fin_home_eq), fin_pension=float(fin_pension),
                hlth_srh=hlth_srh, hlth_bmi=float(hlth_bmi),
                hlth_smoken=hlth_smoken, hlth_smokev=hlth_smokev,
                hlth_adl5a=hlth_adl5a, hlth_iadl5a=hlth_iadl5a,
                cond_hearte=cond_hearte, cond_diabe=cond_diabe,
                cond_cancre=cond_cancre, cond_stroke=cond_stroke,
                cond_hibpe=cond_hibpe, cond_lunge=cond_lunge,
            )

            predictor = MortalityRiskPredictor(horizon=horizon, model=model_choice)
            result = predictor.predict(applicant)

            tier  = result['risk_tier']
            prob  = result['probability']
            color, css_cls = TIER_COLOR[tier]
            icon  = result['icon']

            # Gauge
            st.plotly_chart(make_gauge(prob, tier), use_container_width=True,
                            config={'displayModeBar': False})

            # Result card
            horizon_label = "5-Year" if horizon == "5yr" else "10-Year"
            st.markdown(f"""
            <div class="result-card {css_cls}">
              <div style="font-size:2.6rem">{icon}</div>
              <div class="result-prob">{result['percent']}</div>
              <div class="result-tier" style="color:{color}">{tier} RISK</div>
              <div style="color:#94a3b8;font-size:0.8rem;margin:6px 0">
                {horizon_label} mortality probability · {model_choice.upper()}
              </div>
              <div class="result-advice">{result['advice']}</div>
            </div>
            """, unsafe_allow_html=True)

            # Risk tier legend
            st.markdown("**Risk Tier Reference**")
            tiers = [
                ("🟢 LOW",      "< 5%",   "Standard rates"),
                ("🟡 MODERATE", "5–15%",  "Rate-up or review"),
                ("🟠 ELEVATED", "15–35%", "Rated or exclusions"),
                ("🔴 HIGH",     "> 35%",  "Decline or heavy rating"),
            ]
            tbl = pd.DataFrame(tiers, columns=["Tier", "Probability", "Action"])
            st.dataframe(tbl, hide_index=True, use_container_width=True)

            # Caveat
            st.markdown("""
            <div class="caveat-box">
            ⚠️ <b>Prototype only.</b> Trained on HRS survey population (50+ adults).
            Real-world AUROC on a pre-underwritten applicant pool will be lower.
            Recalibration against your book of business is required before production use.
            </div>
            """, unsafe_allow_html=True)

        except ValueError as e:
            st.error(f"**Input validation error:**\n\n{e}")
        except FileNotFoundError as e:
            st.error(f"**Model not found:**\n\n{e}\n\nRun `phase8_model_training.py` first.")
        except Exception as e:
            st.error(f"**Unexpected error:** {e}")
    else:
        # Placeholder before first prediction
        st.markdown("""
        <div style="background:#111827;border:1px dashed #334155;border-radius:16px;
                    padding:48px 32px;text-align:center;margin-top:20px">
          <div style="font-size:3rem">🛡️</div>
          <div style="color:#64748b;font-size:1.1rem;margin-top:12px">
            Fill in the applicant profile<br>and click <b>Assess Mortality Risk</b>
          </div>
        </div>
        """, unsafe_allow_html=True)

        # Quick reference card
        with st.expander("📖 Feature Reference Guide"):
            st.markdown("""
            | Field | What to enter |
            |---|---|
            | **Self-Rated Health** | 1=Excellent → 5=Poor (most predictive feature) |
            | **ADL Difficulties** | Count of: dressing, walking, bathing, eating, bed transfer |
            | **IADL Difficulties** | Count of: phone, meds, money, shopping, meal prep |
            | **fin_wealth** | All assets minus all debts (can be negative) |
            | **Conditions** | Check all that have *ever* been diagnosed |
            """)
