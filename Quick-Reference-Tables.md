# Insurance AI Platform — Quick Reference Tables

**Updated:** September 8, 2026

---

## Table 1: Gemini API Current Integration

| Service | Purpose | Calls/Policy | Input Tokens | Output Tokens | Cost/Call |
|---------|---------|-------------|--------------|---------------|-----------|
| **Risk Engine** | Medical risk scoring | 1 | 3,000 | 800 | $0.00285 |
| **Risk Engine** | Financial risk scoring | 1 | 2,500 | 600 | $0.00240 |
| **Risk Engine** | Fraud detection | 1 | 2,000 | 500 | $0.00190 |
| **Risk Engine** | Decision aggregation | 1 | 1,500 | 400 | $0.00130 |
| **OCR Engine** | Document extraction (avg) | 1 | 50,000 | 10,000 | $0.03750 |
| **Text Summarizer** | Content summarization | 1 | 5,000 | 1,000 | $0.00425 |
| **Chat Agent** | Message turn (avg) | 1 | 10,000 | 2,000 | $0.00805 |

**Total per complete policy journey:** ~$0.0564 (5.6 cents)

---

## Table 2: Pricing Comparison (All Gemini Models)

| Model | Input Rate | Cached Rate | Output Rate | Use Case | Savings vs 2.5-Flash |
|-------|-----------|------------|------------|----------|-------------------|
| gemini-2.5-flash | $0.30 | $0.03 | $2.50 | 🎯 Current primary | — |
| gemini-2.5-flash-lite | $0.10 | $0.01 | $0.40 | Budget operations | **67% cheaper** |
| gemini-2.0-flash | $0.10 | $0.025 | $0.40 | Cost optimization | **67% cheaper** |
| gemini-2.5-pro | $1.25 | $0.125 | $10.0 | Complex reasoning | 317% MORE expensive |

---

## Table 3: Monthly Cost by Volume

| Daily Policies | LLM Cost | Hosting Cost | Total Monthly | Annual Cost |
|---|---|---|---|---|
| 50 | $939 | $400-1,380 | $1,339-2,319 | $16,068-27,828 |
| **200** | **$3,755** | **$674-1,380** | **$4,429-5,135** | **$53,148-61,620** |
| 500 | $9,387 | $750-2,500 | $10,137-11,887 | $121,644-142,644 |
| 1,000 | $18,774 | $1,200-3,500 | $19,974-22,274 | $239,688-267,288 |

---

## Table 4: Testing Phase Costs

| Testing Type | Policies per Test | Total API Calls | Cost per Test | Monthly Frequency | Monthly Cost |
|---|---|---|---|---|---|
| Unit Testing (mocked) | 0 | 0 | $0 | N/A | $0 |
| Regression Test | 100 | 700 | $3.96 | 2× | $31.68 |
| Load Test | 1,000 | 7,000 | $39.55 | 1× | $39.55 |
| Ad-hoc Tests | Variable | Variable | $39.55 | 3-5× | $119-198 |
| **Total Testing** | — | — | — | — | **$191-270/month** |

---

## Table 5: Infrastructure Cost Comparison (Monthly)

| Component | AWS EKS | AWS ECS Fargate | DigitalOcean VPS |
|---|---|---|---|
| **Compute** | $255 | $245 | $336 |
| **Database (RDS/Managed)** | $280 | $400 | $45 |
| **Storage & Networking** | $73 | $110 | $30 |
| **Monitoring** | $15 | $30 | $10 |
| **Load Balancing** | $16 | $16 | Included |
| **Total Monthly** | **$639** | **$801** | **$421** |
| **Total Annual** | **$7,668** | **$9,612** | **$5,052** |
| **Scalability** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| **Management** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **Enterprise Ready** | ✅ | ✅ | ❌ |

---

## Table 6: Year 1 Budget Breakdown

| Expense Category | Monthly | Annual | % of Total |
|---|---|---|---|
| **LLM API (Gemini)** | $3,129 | $37,548 | 64% |
| **Compute Infrastructure** | $532 | $6,384 | 11% |
| **Database (RDS)** | $350 | $4,200 | 7% |
| **Storage & Networking** | $90 | $1,080 | 2% |
| **Monitoring & Observability** | $100 | $1,200 | 2% |
| **Tools & Licenses** | $50 | $600 | 1% |
| **Contingency (15%)** | $510 | $6,120 | 10% |
| **TOTAL** | **$4,761** | **$57,132** | **100%** |

*Note: Assumes medium deployment (200 policies/day), AWS EKS infrastructure*

---

## Table 7: Cost Optimization Impact

| Optimization | Implementation Time | Monthly Savings | Annual Savings | Effort Required |
|---|---|---|---|---|
| **Prompt Caching** | 2 weeks | $750-900 | $9,000-10,800 | Low ⭐ |
| **Model Downgrade (2.0-Flash)** | 4 weeks | $2,500-3,000 | $30,000-36,000 | Medium ⭐⭐ |
| **Batch Processing** | 3 weeks | $300-500 | $3,600-6,000 | Low ⭐ |
| **Fine-tuning** | 8 weeks | $1,500-2,000 | $18,000-24,000 | High ⭐⭐⭐ |
| **Hybrid LLM Stack** | 12 weeks | $3,000-4,000 | $36,000-48,000 | High ⭐⭐⭐ |

---

## Table 8: Fallback Model Comparison

| Model | Provider | Input Cost | Output Cost | Latency | Quality | PDF Support |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | Google | $0.30 | $2.50 | 2-3s | ⭐⭐⭐⭐⭐ | ✅ |
| gpt-4o-mini | OpenAI | $0.15 | $0.60 | 2-4s | ⭐⭐⭐⭐ | ❌ |
| claude-sonnet-4-5 | Anthropic | $3.00 | $15.00 | 3-5s | ⭐⭐⭐⭐⭐ | ✅ |

---

## Table 9: Deployment Timeline & Costs

| Phase | Duration | Policies/Day | Monthly LLM Cost | Cumulative Cost | Deliverable |
|---|---|---|---|---|---|
| Phase 0: Dev | Weeks 1-2 | 0-10 | $0-50 | $0-100 | Cost analysis (✅ Complete) |
| Phase 1: Testing | Weeks 3-8 | 10-50 | $50-250 | $300-1,500 | Test suite, baselines |
| Phase 2: Soft Launch | Weeks 9-16 | 50-150 | $470-1,410 | $2,350-7,050 | Pilot with Adam Jee |
| Phase 3: Ramp-up | Months 4-6 | 150-250 | $1,410-2,346 | $4,230-7,038 | Full production readiness |
| Phase 4: Scale | Months 7-12 | 250-400 | $2,346-3,755 | $14,076-22,530 | Multi-tenant operations |

---

## Table 10: Cost per Transaction (All Models)

| Scenario | Gemini 2.5 Flash | Gemini 2.0 Flash | GPT-4o Mini | Claude Sonnet |
|---|---|---|---|---|
| **Single Policy Evaluation** | $0.00845 | $0.00260 | $0.00512 | $0.02640 |
| **Average Policy (w/ docs)** | $0.0564 | $0.0218 | $0.0340 | $0.0860 |
| **200 policies/day** | $3,755/mo | $1,254/mo | $2,040/mo | $5,160/mo |
| **Cost Variance** | — | -67% | -46% | +37% |

---

## Table 11: Break-Even Analysis

| Initiative | Setup Cost | Monthly Savings | Break-Even (months) | ROI (Year 1) |
|---|---|---|---|---|
| Prompt Caching | $6,000 | $825 | 7.3 | $3,900 |
| Model Downgrade | $8,000 | $2,750 | 2.9 | $25,000 |
| Fine-tuning | $40,000 | $1,750 | 22.9 | $1,000 |
| Hybrid Stack | $50,000 | $3,500 | 14.3 | $32,000 |

---

## Table 12: Key Metrics Dashboard

| Metric | Current | Target (6mo) | Target (12mo) |
|---|---|---|---|
| **Daily Policy Volume** | 50-100 | 200-300 | 300-500 |
| **Avg Cost per Policy** | $0.0564 | $0.0380 (-33%) | $0.0280 (-50%) |
| **Monthly Gemini Spend** | $1,700 | $3,600 | $6,000 |
| **Cache Hit Ratio** | 0% | 20-30% | 40-50% |
| **Fallback Use Rate** | <1% | 2-5% | 5-10% |
| **System Uptime** | N/A | 99.9% | 99.95% |
| **Avg Response Time** | N/A | <3s | <2s |
| **Cost per Transaction** | $0.0564 | $0.0380 | $0.0280 |

---

## Table 13: Risk Matrix

| Risk | Probability | Impact | Mitigation | Status |
|---|---|---|---|---|
| **Gemini Price Increase** | Medium | High | Volume discount negotiation | 🟡 Ready |
| **Service Outage** | Low | High | Fallback models configured | 🟢 Active |
| **Rate Limiting** | Low | Medium | Request queuing via Kafka | 🟢 Active |
| **Database Failure** | Very Low | Critical | Multi-AZ + backups | 🟢 Active |
| **Cost Overrun** | Medium | High | Budget alerts + guardrails | 🟡 Ready |

---

## Table 14: Decision Matrix for Model Selection

| Scenario | Recommend | Rationale | Cost |
|---|---|---|---|
| **Launch (Quality First)** | Gemini 2.5 Flash | Best reasoning, FDA-ready | $3,755/mo |
| **Scale (Cost Focus)** | Gemini 2.0 Flash | 67% cheaper, good performance | $1,254/mo |
| **Hybrid (Balanced)** | 70% Gemini Flash + 30% 2.0 | Balance quality & cost | $2,880/mo |
| **Budget Constrained** | GPT-4o Mini + Fallback | Lower cost alternative | $2,040/mo |
| **Maximum Quality** | Gemini 2.5 Pro | Best reasoning, high cost | $9,300/mo |

---

## Table 15: Vendor Comparison (Annual Cost @ 200 policies/day)

| Vendor | Model | Annual LLM Cost | Annual Infrastructure | Total Annual | Best For |
|---|---|---|---|---|---|
| **Google** | Gemini 2.5 Flash | $45,060 | $7,668 | $52,728 | ⭐ Recommended |
| **Google** | Gemini 2.0 Flash | $15,048 | $7,668 | $22,716 | Cost optimization |
| **OpenAI** | GPT-4o Mini | $24,480 | $7,668 | $32,148 | Fallback option |
| **Anthropic** | Claude Sonnet | $61,920 | $7,668 | $69,588 | High quality |
| **Hybrid** | Mixed stack | $35,000 | $7,668 | $42,668 | Balanced approach |

---

## Table 16: Approval Checklist

| Item | Status | Owner | Due Date |
|---|---|---|---|
| **Budget Approval ($59K-65K)** | ⏳ | Finance | This week |
| **Infrastructure Selection** | ⏳ | CTO | This week |
| **Cost Optimization Strategy** | ✅ | Engineering | — |
| **Monitoring Dashboard Setup** | ✅ | DevOps | — |
| **Team Resource Allocation** | ⏳ | HR/PMO | Next week |
| **Vendor Contract Review** | ⏳ | Legal | Next week |
| **Security Audit** | ⏳ | Security | Week 2 |
| **Go-live Authorization** | ⏳ | CEO | Week 4 |

---

## How to Use These Tables

### For Finance
→ Use Tables 1, 3, 5, 6, 15 for budget planning and approval

### For Engineering
→ Use Tables 1, 2, 7, 11, 14 for implementation planning

### For Operations
→ Use Tables 3, 9, 12, 13 for deployment and monitoring

### For Leadership
→ Use Tables 3, 6, 15, 16 for strategic decisions

---

**Last Updated:** September 8, 2026  
**Next Update:** December 8, 2026
