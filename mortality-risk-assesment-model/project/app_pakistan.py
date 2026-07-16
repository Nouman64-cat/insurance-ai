"""
app_pakistan.py  —  Life Insurance Mortality Risk Underwriting App for Pakistan
Run with:  streamlit run app_pakistan.py
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

import streamlit as st
import pandas as pd
import plotly.graph_objects as go
from inference import PakistaniMortalityRiskPredictor, ApplicantProfile

# ── Page config ────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="InsureIQ — Pakistan Mortality Risk Assessment",
    page_icon="🛡️",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Custom CSS ─────────────────────────────────────────────────────────────
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

html, body, [class*="css"] { font-family: 'Inter', sans-serif; }
.main { background: #0a0d14; }
.hero { background: linear-gradient(135deg, #0f2027, #203a43, #2c5364); border-radius: 16px; padding: 32px 40px; margin-bottom: 28px; border: 1px solid #1e3a4a; }
.hero h1 { color: #ffffff; font-size: 2.1rem; font-weight: 700; margin: 0; }
.hero p  { color: #94a3b8; font-size: 1.05rem; margin: 8px 0 0; }
.section-card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; }
.section-title { color: #60a5fa; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #1f2937; }
.result-card { border-radius: 16px; padding: 28px 32px; text-align: center; margin-bottom: 16px; }
.result-low      { background: linear-gradient(135deg, #052e16, #14532d); border: 1px solid #16a34a; }
.result-moderate { background: linear-gradient(135deg, #422006, #713f12); border: 1px solid #d97706; }
.result-elevated { background: linear-gradient(135deg, #431407, #7c2d12); border: 1px solid #ea580c; }
.result-high     { background: linear-gradient(135deg, #3b0764, #7f1d1d); border: 1px solid #dc2626; }
.result-prob { font-size: 3.6rem; font-weight: 700; color: #ffffff; line-height: 1; }
.result-tier { font-size: 1.4rem; font-weight: 600; margin: 8px 0; }
.result-advice { color: #cbd5e1; font-size: 0.95rem; margin-top: 10px; }
.caveat-box { background: #1c1f2a; border-left: 3px solid #f59e0b; border-radius: 0 8px 8px 0; padding: 12px 16px; margin-top: 16px; color: #94a3b8; font-size: 0.85rem; }
.disclosure-box { background: #1e3a8a; border-left: 3px solid #3b82f6; border-radius: 0 8px 8px 0; padding: 12px 16px; margin-bottom: 20px; color: #dbeafe; font-size: 0.95rem; }
stButton button { background: linear-gradient(135deg, #3b82f6, #6366f1) !important; color: white !important; border: none !important; border-radius: 10px !important; padding: 12px 28px !important; font-weight: 600 !important; font-size: 1rem !important; width: 100%; }
</style>
""", unsafe_allow_html=True)

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
            'axis': {'range': [0, 100], 'tickcolor': '#475569', 'tickfont': {'color': '#94a3b8', 'size': 11}},
            'bar':  {'color': color, 'thickness': 0.28},
            'bgcolor': '#1e293b',
            'borderwidth': 0,
            'steps': [
                {'range': [0,  5],  'color': '#052e16'},
                {'range': [5,  15], 'color': '#422006'},
                {'range': [15, 35], 'color': '#431407'},
                {'range': [35, 100],'color': '#3b0764'},
            ],
            'threshold': {'line': {'color': color, 'width': 3}, 'thickness': 0.85, 'value': prob * 100},
        },
    ))
    fig.update_layout(
        height=230, margin=dict(l=20, r=20, t=20, b=10),
        paper_bgcolor='rgba(0,0,0,0)', plot_bgcolor='rgba(0,0,0,0)', font={'color': '#f1f5f9'},
    )
    return fig

# Hero
st.markdown("""
<div class="hero">
  <h1>🛡️ InsureIQ — Pakistan Mortality Risk (Calibrated)</h1>
  <p>AI-powered mortality risk assessment with Bayesian credibility calibration using Pakistan Demographic Survey (PDS) data.</p>
</div>
""", unsafe_allow_html=True)

# ── Permanent Disclosure Panel ──────────────────────────────────────────────
st.markdown("""
<div class="disclosure-box">
  <b>Transparency Disclosure:</b><br/>
  This model's <b>baseline mortality rates are locally calibrated</b> to Pakistan national mortality data (PDS-2020). 
  However, the <b>relative risk factors</b> (such as BMI, SES, and chronic conditions) are still derived from the US (HRS dataset) 
  and have not been locally validated on individual Pakistani mortality outcomes.
</div>
""", unsafe_allow_html=True)

# ── Sidebar: model config ─────────────────────────────────────────────────
with st.sidebar:
    st.markdown("## ⚙️ Model Settings")
    horizon = st.selectbox("Prediction Horizon", options=["5yr", "10yr"],
                           format_func=lambda x: "5-Year Mortality" if x == "5yr" else "10-Year Mortality")
    model_choice = "xgboost" # Forced best model for simplicity
    credibility_z = st.slider("Credibility Factor (Z)", min_value=0.0, max_value=1.0, value=0.85, step=0.05,
                              help="Weight given to the local Pakistan (PDS) mortality anchor.")
    
    st.markdown("---")
    show_debug = st.checkbox("Show QA/Debug Panel", value=True, help="Toggle for underwriter validation.")

# ── Input form ────────────────────────────────────────────────────────────
col_form, col_result = st.columns([1.1, 0.9], gap="large")

with col_form:
    with st.form("applicant_form"):
        # Demographic
        st.markdown('<div class="section-card"><div class="section-title">👤 Demographic</div>', unsafe_allow_html=True)
        c1, c2, c3 = st.columns(3)
        gender    = c1.selectbox("Gender", [1, 2], format_func=lambda x: "Male" if x == 1 else "Female")
        birth_yr  = c2.number_input("Birth Year", min_value=1920, max_value=2000, value=1965, step=1)
        demo_age  = c3.number_input("Age at Application", min_value=50, max_value=95, value=58, step=1, format="%d")
        
        # PROXY/DROP handling: hispan=0, demo_region=3 (arbitrary), fin_pension=0 (not common in PK)
        demo_mstat = st.selectbox("Marital Status", [1, 2, 3, 4, 5, 7],
            format_func=lambda x: {1:"Married",2:"Partnered",3:"Separated",4:"Divorced",5:"Widowed",7:"Never Married"}[x])
        st.markdown('</div>', unsafe_allow_html=True)

        # Education & Financials
        st.markdown('<div class="section-card"><div class="section-title">🎓 Education & 💰 Financials (PKR to USD proxy)</div>', unsafe_allow_html=True)
        c1, c2 = st.columns(2)
        educ = c1.slider("Years of Education", 0, 17, 10)
        fin_income = c2.number_input("Household Income Equivalent (USD/yr)", 0, 2_000_000, 10_000, step=1000)

        c3, c4 = st.columns(2)
        fin_wealth = c3.number_input("Total Net Wealth (USD)", -500_000, 10_000_000, 50_000, step=5000)
        fin_wealth_liquid = c4.number_input("Liquid Assets (USD)", 0, 5_000_000, 10_000, step=1000)
        
        fin_home_eq = st.number_input("Home Equity (USD)", 0, 5_000_000, 30_000, step=5000)
        st.markdown('</div>', unsafe_allow_html=True)

        # Health
        st.markdown('<div class="section-card"><div class="section-title">🩺 Health Status</div>', unsafe_allow_html=True)
        c1, c2, c3 = st.columns(3)
        hlth_srh = c1.select_slider(
            "Self-Rated Health", options=[1, 2, 3, 4, 5], value=3,
            format_func=lambda x: {1:"Excellent",2:"Very Good",3:"Good",4:"Fair",5:"Poor"}[x]
        )
        hlth_bmi = c2.number_input("BMI (kg/m²)", 12.0, 70.0, 24.5, step=0.5)
        hlth_adl5a = c3.slider("ADL Difficulties (0-5)", 0, 5, 0)

        c4, c5, c6 = st.columns(3)
        hlth_smoken = c4.selectbox("Current Smoker", [0, 1], format_func=lambda x: "No" if x == 0 else "Yes")
        hlth_smokev = c5.selectbox("Ever Smoked", [0, 1], format_func=lambda x: "No" if x == 0 else "Yes")
        hlth_iadl5a = c6.slider("IADL Difficulties (0-5)", 0, 5, 0)
        st.markdown('</div>', unsafe_allow_html=True)

        # Conditions
        st.markdown('<div class="section-card"><div class="section-title">🏥 Chronic Conditions</div>', unsafe_allow_html=True)
        cc1, cc2, cc3 = st.columns(3)
        cond_hearte = int(cc1.checkbox("❤️ Heart Disease"))
        cond_diabe  = int(cc1.checkbox("🩸 Diabetes"))
        cond_cancre = int(cc2.checkbox("🎗️ Cancer"))
        cond_stroke = int(cc2.checkbox("🧠 Stroke / TIA"))
        cond_hibpe  = int(cc3.checkbox("🔴 Hypertension"))
        cond_lunge  = int(cc3.checkbox("💨 Lung Disease"))
        st.markdown('</div>', unsafe_allow_html=True)

        submitted = st.form_submit_button("🔍 Assess Mortality Risk")

# ── Result panel ──────────────────────────────────────────────────────────
with col_result:
    if submitted:
        try:
            # Set dropped/proxy features to defaults
            hispan = 0
            demo_region = 3 # arbitrary mapping
            fin_pension = 0
            
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

            predictor = PakistaniMortalityRiskPredictor(horizon=horizon, model=model_choice, Z=credibility_z)
            result = predictor.predict(applicant)

            if not result.get('is_calibrated'):
                st.warning("⚠️ This age band is not supported for calibration. (Only 50+ is fully supported by the model). Below is the UNCALIBRATED raw output.")
            
            tier  = result['risk_tier']
            prob  = result['probability']
            color, css_cls = TIER_COLOR[tier]
            icon  = result['icon']

            st.plotly_chart(make_gauge(prob, tier), config={'displayModeBar': False})

            horizon_label = "5-Year" if horizon == "5yr" else "10-Year"
            st.markdown(f"""
            <div class="result-card {css_cls}">
              <div style="font-size:2.6rem">{icon}</div>
              <div class="result-prob">{result['percent']}</div>
              <div class="result-tier" style="color:{color}">CALIBRATED {tier} RISK</div>
              <div style="color:#94a3b8;font-size:0.8rem;margin:6px 0">
                {horizon_label} mortality probability · Z={credibility_z}
              </div>
              <div class="result-advice">{result['advice']}</div>
            </div>
            """, unsafe_allow_html=True)
            
            # QA Panel
            if show_debug and result.get('is_calibrated'):
                st.markdown("### 🛠️ Internal QA Panel")
                st.code(f"Raw Model Probability : {result['raw_percent']}\n"
                        f"Bucket Model Average  : {result['bucket_model_avg']:.4f}\n"
                        f"Bucket Pakistan qx    : {result['bucket_pakistan_qx']:.4f}\n"
                        f"Credibility Factor Z  : {result['Z']}\n"
                        f"Calibrated Probability: {result['percent']}")

        except ValueError as e:
            st.error(f"**Input validation error:**\n\n{e}")
        except FileNotFoundError as e:
            st.error(f"**Model not found:**\n\n{e}\n\nRun `phase8_model_training.py` first.")
        except Exception as e:
            st.error(f"**Unexpected error:** {e}")
    else:
        st.markdown("""
        <div style="background:#111827;border:1px dashed #334155;border-radius:16px;
                    padding:48px 32px;text-align:center;margin-top:20px">
          <div style="font-size:3rem">🛡️</div>
          <div style="color:#64748b;font-size:1.1rem;margin-top:12px">
            Fill in the applicant profile<br>and click <b>Assess Mortality Risk</b>
          </div>
        </div>
        """, unsafe_allow_html=True)
