# Insurance AI Platform — Cost Analysis Documents

**Analysis Date:** September 8, 2026  
**Prepared By:** Senior FinTech Engineer  
**Project:** insurance-ai (AI-Powered Insurance Underwriting Platform)

---

## 📋 Document Index

This analysis package contains **3 comprehensive documents** covering all aspects of Gemini API usage and deployment costs:

### 1. 📊 **Insurance-AI-Cost-Analysis.md** (Main Report)
**Length:** 12,000+ words | **Audience:** Technical, Finance, Executive  
**Purpose:** Comprehensive end-to-end cost analysis with detailed breakdowns

**Contains:**
- ✅ Current Gemini API integration across 4 services
- ✅ Pricing structure and per-request costs
- ✅ Testing phase cost estimates (unit, regression, load testing)
- ✅ Production deployment scenarios (50, 200, 500+ policies/day)
- ✅ Hosting cost comparison (AWS ECS, EKS, DigitalOcean)
- ✅ Cost optimization strategies (short, medium, long-term)
- ✅ 12-month financial projections
- ✅ Risk assessment and mitigation
- ✅ Monitoring recommendations
- ✅ Detailed appendices and reference tables

**Read this for:** Complete understanding of costs and business implications

---

### 2. ⚡ **Cost-Analysis-Executive-Summary.md**
**Length:** 2,500 words | **Audience:** Finance, Leadership, Stakeholders  
**Purpose:** Quick reference with key metrics and decisions

**Contains:**
- ✅ Quick facts and current setup
- ✅ Where Gemini is used (4 services summary)
- ✅ Cost by testing phase (single table view)
- ✅ Production deployment costs (3 scenarios)
- ✅ Infrastructure hosting options comparison
- ✅ Cost optimization opportunities
- ✅ Year-1 financial projection
- ✅ Risk factors and key metrics
- ✅ Immediate next steps
- ✅ Approval checklist

**Read this for:** Decision-making, budget approval, stakeholder communication

---

### 3. 🔧 **Cost-Calculation-Reference.md**
**Length:** 3,000+ words | **Audience:** Finance analysts, Engineers, Operations  
**Purpose:** Detailed calculations, formulas, and SQL queries for cost tracking

**Contains:**
- ✅ Gemini API pricing matrix (all models)
- ✅ Cost per service calculation (step-by-step)
- ✅ Daily volume cost calculator
- ✅ Monthly cost aggregation template
- ✅ Testing phase detailed breakdown
- ✅ Infrastructure cost formulas
- ✅ Quick calculation Python function
- ✅ Budget allocation template
- ✅ Break-even analysis
- ✅ SQL queries for cost monitoring

**Read this for:** Detailed calculations, building dashboards, ongoing monitoring

---

## 🎯 Quick Navigation

### "I need a 5-minute overview"
→ Read: **Cost-Analysis-Executive-Summary.md**  
→ Focus: Sections 1-2 (Quick Facts, Where Gemini is Used)

### "I need to approve a budget"
→ Read: **Cost-Analysis-Executive-Summary.md**  
→ Focus: Sections 5-6 (Deployment Costs, Projections)

### "I need to understand all technical details"
→ Read: **Insurance-AI-Cost-Analysis.md** (full)

### "I need to calculate specific scenarios"
→ Read: **Cost-Calculation-Reference.md**  
→ Focus: Sections 2-3 (Cost Calculator, Daily Volumes)

### "I need to monitor costs in production"
→ Read: **Cost-Calculation-Reference.md**  
→ Focus: Section 10 (SQL Queries)

---

## 📈 Key Findings Summary

### Current Setup
- **Model:** Google Gemini 2.5 Flash
- **Pricing:** $0.30/1M input tokens, $2.50/1M output tokens
- **Cost per policy evaluation:** ~$0.056 (5.6 cents)

### Where It's Used
1. **Risk Engine** — Medical & Financial scoring (3-4 calls per policy)
2. **OCR Engine** — Document text extraction (1 call per document)
3. **Text Summarizer** — Content summarization (1 call per summary)
4. **Chat Agent** — Conversational AI (2-7 turns per conversation)

### Testing Costs
- Unit Testing: $0-5/month (mocked)
- Regression Testing: $32/month
- Load Testing: $250/month
- **Total:** ~$282-287/month

### Production Deployment (Medium: 200 policies/day)
- **Monthly LLM Cost:** $3,755
- **Monthly Infrastructure:** $674-1,380
- **Monthly Total:** $4,429-5,135
- **Annual Cost:** $53,148-61,620

### Production Deployment (Large: 500 policies/day)
- **Monthly LLM Cost:** $9,387
- **Monthly Infrastructure:** $750-2,500
- **Monthly Total:** $10,137-11,887
- **Annual Cost:** $121,644-142,644

### Cost Optimization Potential
- **Prompt Caching:** 20-30% input token savings (0-1 month)
- **Model Downgrade:** 65-70% total cost savings (3-6 months)
- **Hybrid LLM Stack:** 40-50% savings (6-12 months)

---

## 💰 Financial Summary

### Year 1 Budget Estimates (Recommended: Medium Scenario)

| Category | Cost |
|----------|------|
| LLM API (Gemini) | $38,540 |
| Infrastructure (AWS EKS) | $8,088 |
| Database (RDS) | $4,200 |
| Storage & Networking | $1,080 |
| Monitoring & Tools | $1,200 |
| Contingency (15%) | $6,120 |
| **TOTAL YEAR 1** | **$59,228** |

**Average Monthly:** ~$4,936

---

## 🎯 Recommended Actions

### Immediate (This Week)
1. ✅ Select hosting provider (AWS EKS recommended)
2. ✅ Set up billing alerts
3. ✅ Finalize budget approval

### Next 2 Weeks
1. ✅ Deploy production monitoring
2. ✅ Create cost dashboard
3. ✅ Begin soft launch (50-100 policies/day)

### Month 2
1. ✅ Enable prompt caching (20-30% savings)
2. ✅ Validate cost projections with actual data
3. ✅ Plan model optimization

### Months 3-6
1. ✅ Evaluate Gemini 2.0 Flash (cost savings analysis)
2. ✅ Negotiate volume discounts (if >$50K/month)
3. ✅ Implement fallback strategy

### Months 6-12
1. ✅ Assess fine-tuning ROI
2. ✅ Plan hybrid LLM architecture
3. ✅ Year 2 budget planning

---

## 📊 Monitoring & Dashboard

### What to Track Weekly
- Total API calls count
- Average cost per policy
- Model latency and error rates
- Cache hit ratio (once caching enabled)

### What to Track Monthly
- Actual vs. budgeted spend
- Cost per transaction trending
- Service-level cost breakdown
- Tenant cost attribution

### What to Track Quarterly
- Year-over-year cost growth
- Optimization opportunity assessment
- Scaling readiness analysis
- Vendor negotiation readiness

**Dashboard Location:** `/frontend/app/super-admin/tokens/page.tsx` (already implemented)

---

## 🏗️ Infrastructure Recommendation

### Recommended: AWS EKS (Kubernetes)

**Why?**
- Auto-scaling for variable load
- Multi-region ready for disaster recovery
- Cost-effective for enterprise workloads
- Industry standard for financial services

**Monthly Cost:** $674-894 (including RDS)

**Alternative:** AWS ECS Fargate ($860-1,380/month) for lighter DevOps overhead

---

## 📞 Contact & Questions

| Role | Email | Responsibility |
|------|-------|-----------------|
| Finance | finance@company.com | Budget approval, cost controls |
| DevOps | devops@company.com | Infrastructure, monitoring |
| Engineering | engineering@company.com | Cost optimization, model selection |

---

## 📋 Document Checklist

Use this when presenting costs to stakeholders:

- [ ] **Executive Summary** read (Cost-Analysis-Executive-Summary.md)
- [ ] **Key metrics** understood (Section 1-2 of summary)
- [ ] **Deployment scenarios** reviewed (Section 5 of summary)
- [ ] **Cost projections** validated (Section 9 of full report)
- [ ] **Optimization strategy** approved (Section 7 of full report)
- [ ] **Infrastructure** selected (Section 5.2 of full report)
- [ ] **Budget** allocated and approved
- [ ] **Monitoring** dashboard set up
- [ ] **Team** trained on cost controls

---

## 🔐 Confidentiality

**Classification:** Internal - Finance & Operations  
**Retention:** 3 years (for compliance)  
**Sharing:** Restricted to Finance, C-suite, and Technical Leadership

---

## 📝 Version History

| Version | Date | Updates |
|---------|------|---------|
| 1.0 | Sept 8, 2026 | Initial comprehensive analysis |

**Next Review:** December 8, 2026 (Quarterly)

---

## 🚀 How to Use This Package

### For Finance/Budgeting
1. Read: Executive Summary (2-3 minutes)
2. Extract: Year 1 budget from Section 9
3. Present: Key findings from "Key Findings Summary" above
4. Approve: Budget allocation template from Cost-Calculation-Reference

### For Technical Teams
1. Read: Main report Section 1-4 (Current Setup & Costs)
2. Reference: Calculation guide for project planning
3. Implement: Cost monitoring SQL queries (Section 10)
4. Deploy: Budget guard mechanism (mentioned in main report Section 11)

### For Product/Operations
1. Read: Executive Summary (all sections)
2. Track: Key metrics in Section "Monitoring & Dashboard"
3. Plan: Scaling according to financial projections
4. Review: Quarterly for optimization opportunities

---

**Questions? Refer to the full report or contact the Senior FinTech Engineer.**

---

**Last Updated:** September 8, 2026  
**Status:** ✅ Ready for Distribution
