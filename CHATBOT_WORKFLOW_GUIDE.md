# Insurance AI Chatbot & Workflow Guide

## Overview

The enhanced Insurance AI Agent is your intelligent guide through the complete insurance underwriting workflow. It provides:

✅ **Smart Recommendations** - Suggests the next best step at each stage  
✅ **Process Visualization** - See the workflow progression in real-time  
✅ **One-Click Actions** - Quick buttons to move through the workflow  
✅ **Demo Mode** - Test the entire process with auto-generated data  
✅ **Smart Navigation** - Navigate to pages and highlight specific items  
✅ **Intelligent Tool Execution** - AI executes complex workflows step-by-step  

---

## Complete Insurance Workflow

The insurance journey has **7 stages**. The chatbot guides you through each:

### **Stage 1: Add Customer** 👤
**What it does:** Register a new applicant with personal and financial information  
**Required data:**
- First name, Last name
- CNIC (format: XXXXX-XXXXXXX-X)
- Date of birth (YYYY-MM-DD)
- Gender (Male/Female/Other)
- Occupation
- Declared annual income

**How to use:**
```
Tell the bot: "Add a customer named Ahmed Khan, CNIC 35201-1234567-1, DOB 1985-03-15, Software Engineer, income 800000"
```

**Next step:** Create a case

---

### **Stage 2: Create Case** 📋
**What it does:** Start an underwriting, claim, or inquiry case for the customer  
**Case types:**
- `Underwriting` (default) - Insurance application evaluation
- `Claim` - Insurance claim processing
- `Inquiry` - General customer inquiry

**Required data:**
- Customer CNIC or name (from stage 1)
- Case type (optional, defaults to "Underwriting")
- Priority level (optional: Low, Normal, High, Critical)

**How to use:**
```
Tell the bot: "Create an underwriting case for Ahmed Khan with high priority"
```

**What happens:**
- Case number auto-generated (e.g., CASE-2026-A3F9C1)
- Case status starts as "New"
- Case appears in the Underwriting & Applications pages

**Next step:** Create a proposal

---

### **Stage 3: Create Proposal** 📄
**What it does:** Define the insurance product and coverage details  
**Required data:**
- Customer CNIC or name
- Product name (e.g., "Term Life Plus")
- Insurance type (Life, Health, Auto, Property)
- Coverage amount (sum assured)
- Term years (policy duration)

**How to use:**
```
Tell the bot: "Create a proposal for Ahmed Khan: Product=Term Life Plus, Coverage=5000000 PKR, Term=20 years"
```

**What happens:**
- Policy created and linked to the case
- Ready for risk assessment

**Next step:** Run risk assessment (or upload documents first)

---

### **Stage 4: Run Risk Assessment** 🔍
**What it does:** AI evaluates the applicant across three dimensions  
**AI scores:**
1. **Medical Score** (0-100)
   - Age, gender, health indicators
   - Smoking status, BMI
   - Pre-existing conditions

2. **Financial Score** (0-100)
   - Coverage ratio (coverage ÷ income)
   - Income stability
   - Debt-to-income ratio

3. **Fraud Probability** (0.0-1.0)
   - Network analysis (Memgraph)
   - Occupation fraud patterns
   - Suspicious income outliers

**Composite Decision:**
```
composite = (0.40 × medical) + (0.40 × financial) + (0.20 × fraud × 100)

Auto Approve      → composite < 30  AND  fraud < 0.10
Human Review      → everything else (most common)
Decline           → composite > 75  OR   fraud > 0.60
```

**How to use:**
```
Tell the bot: "Run risk assessment for Ahmed Khan's case"
```

**Before running:**
- ⚠️ Check required documents are uploaded first
- The chatbot will remind you if documents are missing
- Available documents: CNIC, Salary Slip, Bank Statement, Medical Report

**After completion:**
- Scores saved to database
- Detailed explanations for each score
- Results appear in the Underwriting page

**Next step:** Upload documents (if missing), then review & decide

---

### **Stage 5: Upload Documents** 📎
**What it does:** Collect required documents for the case  
**Document types:**
- CNIC (Identity proof)
- Salary Slip (Income verification)
- Bank Statement (Financial health)
- Medical Report (Medical evaluation)

**How to use:**
```
Tell the bot: "Upload CNIC for Ahmed Khan" → Bot shows upload interface
```

**What the bot does:**
- Shows the document checklist
- Highlights which documents are required
- Shows which documents have been received
- Alerts when documents are missing before risk assessment

**Next step:** Review & decide

---

### **Stage 6: Review & Update Status** ✓
**What it does:** Move the case through the workflow and make final decision  
**Case status progression:**
```
New → InProgress → Pending Documents / Under Review → Approved/Rejected → Closed
```

**How to use:**
```
Tell the bot: "Update Ahmed Khan's case status to Under Review"
```

**Common operations:**
```
"Move case to In Progress"
"Request documents from customer"
"Move to Under Review for final decision"
"Approve the case"
"Reject the case"
```

**What happens at each status:**
- **New:** Just created, awaiting assignment
- **InProgress:** Active work in progress
- **Pending Documents:** Waiting for customer to provide missing files
- **Under Review:** Ready for underwriter's final decision
- **Approved:** Application approved, policy issued
- **Rejected:** Application declined
- **Closed:** Case finalized

**Next step:** Close case (when decision made)

---

### **Stage 7: Close Case** 🏁
**What it does:** Finalize the case and complete the workflow  
**How to use:**
```
Tell the bot: "Close Ahmed Khan's case"
```

**What happens:**
- Case marked as "Closed"
- Audit trail recorded
- Application process complete

**Workflow Complete!** ✅

---

## Smart Features

### 1. **Workflow Recommendations**
After each action, the bot automatically recommends the next step:

```
User: "I just created a customer"
Bot: "✅ Next Step: Create an underwriting case for this customer"
     [Create Case Now] button
```

### 2. **Quick Action Buttons**
Most bot responses include action buttons:
- **[View Lead]** - Navigate to lead details
- **[Create Case Now]** - Quick action to create case
- **[Run Risk Assessment]** - Execute assessment
- **[View Case]** - Go to case details

**Click any button to execute that action immediately.**

### 3. **Visual Workflow Indicator**
The chatbot shows a **compact workflow timeline** at the top:
```
👤 → 📋 → 📄 → 🔍 → 📎 → ✓ → 🏁
```

- **Gray** = Not started yet
- **Blue (pulsing)** = Currently active
- **Green** = Completed
- **Red** = Error/blocked

Click any stage to navigate or view details.

### 4. **Demo Mode with Auto-Generated Data**
Perfect for testing and learning:

```
User: "Let me test with demo data"
Bot: "🚀 Quick Start Mode: I'll generate realistic demo data..."

Bot generates:
👤 Ahmed Khan
- CNIC: 35201-1234567-1
- Age: 38
- Income: PKR 1,200,000
- Occupation: Software Engineer

[Create Case Now]
```

The chatbot then walks you through the entire workflow with realistic data.

### 5. **Intelligent Data Parsing**
The chatbot automatically normalizes input:

```
Input: "Ahmed, 35201 1234567 1, born 12/14/1985, 50kpkr income"
Auto-converts to:
- Name: Ahmed (used for first & last name)
- CNIC: 35201-1234567-1 (formatted)
- DOB: 1985-12-14 (standardized)
- Income: 50000 (numeric conversion)
```

### 6. **Navigation with Highlighting**
When you navigate to a page from the bot:
```
[View Case] → Takes you to Cases page → Automatically highlights the case
```

The case will have a **blue outline** with a pulsing animation for 3 seconds so you can spot it immediately.

### 7. **Process Transparency**
The bot explains what's happening:
```
"Running risk assessment...
1️⃣ Evaluating medical factors (age, health)
2️⃣ Analyzing financial situation (income, coverage ratio)
3️⃣ Checking fraud indicators (network analysis)
4️⃣ Computing final decision...

Results: Medical=62, Financial=78, Fraud=0.15 → Recommendation: Human Review"
```

---

## Tips & Best Practices

### ✅ Do

1. **Use the bot to guide complex workflows**
   - "I have a new customer, what should I do?"
   - Bot will walk you through the entire process

2. **Test with demo data first**
   - "Let me test the full workflow with demo data"
   - Great for learning the platform

3. **Use quick action buttons**
   - Instead of manually navigating, click the buttons the bot provides
   - Much faster and more reliable

4. **Read the workflow recommendations**
   - After each action, the bot suggests the next step
   - Follow them for the optimal workflow

5. **Upload documents before running assessment**
   - The bot will check for required documents first
   - Follow the document checklist

### ❌ Don't

1. **Don't invent data**
   - If you don't have a CNIC, let the bot ask for it
   - Never make up customer information

2. **Don't skip the case creation step**
   - A case must exist before running assessments
   - Always: Customer → Case → Proposal → Assessment

3. **Don't run assessment without required documents**
   - Some insurance types require medical reports, bank statements, etc.
   - The bot will remind you

4. **Don't close a case prematurely**
   - Make sure assessment is complete and decision is made
   - Follow the status progression

---

## Example Workflows

### Workflow A: Complete Full Process (Recommended)

```
Step 1: "I have a new customer: Ahmed Khan, CNIC 35201-1234567-1, 
        DOB 1985-03-15, Male, Software Engineer, income 800000"
        ↓
        Bot: "✅ Customer added! Next: Create case"
        [Create Case Now]

Step 2: "Create an underwriting case for Ahmed Khan"
        ↓
        Bot: "✅ Case CASE-2026-A3F9C1 created! Next: Create proposal"
        [Create Proposal]

Step 3: "Create a proposal for Ahmed Khan: 
        Product=Term Life Plus, Coverage=5000000, Term=20"
        ↓
        Bot: "✅ Proposal created! Next: Upload documents or run assessment"

Step 4: "Run risk assessment for Ahmed Khan"
        ↓
        Bot: "⚠️ Missing documents: Salary Slip, Bank Statement"
        [Upload Salary Slip] [Upload Bank Statement]

Step 5: "Upload salary slip for Ahmed Khan" 
        ↓
        Bot: Upload interface → User selects file → Bot uploads

Step 6: "Run risk assessment"
        ↓
        Bot: "Evaluating... Medical: 65, Financial: 72, Fraud: 0.10"
        "Recommendation: Human Review"
        [View Results] [Update Case Status]

Step 7: "Move case to Under Review"
        ↓
        Bot: "✅ Case status updated to Under Review"

Step 8: "Approve the case"
        ↓
        Bot: "✅ Case approved!"

Step 9: "Close the case"
        ↓
        Bot: "✅ Case closed. Application complete!"
```

### Workflow B: Quick Demo

```
User: "Show me the complete workflow with demo data"
Bot: "🚀 Generating realistic customer data..."
     👤 Fatima Ahmed, Income: 1,500,000 PKR
     [Create Case Now]

Bot walks through Steps 1-9 automatically, showing realistic results
at each stage. Perfect for learning and testing the platform.
```

### Workflow C: Batch Processing

```
User: "Add bulk customers"
Bot: Provides template
User: Provides JSON with multiple customers
Bot: "Successfully added 25 customers"
     [View All Leads]

User: Can then create cases for each customer using the bot
```

---

## Troubleshooting

### "Case not found"
- Make sure the case exists (check Underwriting or Applications page)
- Use the exact CNIC or case number
- If newly created, refresh the page first

### "Cannot run assessment - missing documents"
- The bot shows which documents are required
- Upload them first using the [Upload Document] button
- Then run assessment again

### "Customer not found"
- Make sure customer was added successfully
- Check they appear in the Leads page
- Use the exact name or CNIC used when creating

### "Permission denied"
- Your user role doesn't have permission for that action
- Admin/Underwriter roles needed for most operations
- Contact your administrator

### Bot is not responding
- Check your internet connection
- Refresh the page
- Check browser console for errors (F12)
- Make sure you're logged in

---

## System Architecture

### Frontend Components
- **EnhancedChatBot.tsx** - Main chat interface with workflow visualization
- **ProcessFlow.tsx** - Visual workflow timeline component
- **useHighlightTarget.ts** - Element highlighting and scroll-to-target

### Backend Services
- **chat-agent** (Port 8006) - LangGraph conversational agent
- **api-gateway** (Port 8010) - Routes chat requests + underwriting
- **tenant-service** (Port 8011) - Case, customer, and workflow management
- **risk-engine** (Port 8012) - AI risk assessment engine

### Tools Available
1. `add_customer` - Register new applicant
2. `create_case` - Start underwriting case
3. `create_proposal` - Define insurance product
4. `run_risk_assessment` - AI evaluation
5. `update_case_status` - Move through workflow
6. `assign_case` - Assign to underwriter
7. `list_cases` - View all cases
8. `get_case_details` - Fetch case information
9. `add_case_comment` - Add internal notes
10. `get_workflow_recommendation` - Get next step suggestion
11. `upload_document` - Client-side document upload
12. `quick_start_workflow` - Demo mode
13. `navigate_to_page` - Navigate to UI pages

---

## FAQ

**Q: Can I use the chatbot without entering customer details?**
A: Yes! Use "Quick Start" or "Demo Mode" to auto-generate realistic customer data.

**Q: How accurate are the risk scores?**
A: Very accurate. They're calculated by Gemini 2.5 Flash (Google's latest LLM) using:
- Medical models trained on insurance industry data
- Financial analysis using standard insurance ratios
- Fraud detection using graph analysis + LLM intelligence

**Q: Can I edit a case after creation?**
A: Yes, use "Update case status" or add comments. For complex edits, use the web UI.

**Q: How long does risk assessment take?**
A: Typically 30-60 seconds. The bot shows you the progress.

**Q: Can I process multiple customers at once?**
A: Yes! Use "bulk_add_customers" and provide JSON with customer details.

**Q: What happens if assessment fails?**
A: The bot shows the error and suggests next steps. Usually it's missing documents or invalid data.

**Q: Is my data secure?**
A: Yes. All data is encrypted in transit. Audit trails track all actions. Multi-tenant isolation ensures data separation.

---

## Quick Reference

### Keyboard Shortcuts
- `Shift + Enter` - New line in chat message
- `Enter` - Send message
- Clear chat history - Click 🔄 button

### Command Examples
```
"I have a new customer"
"Create a case for CNIC 35201-1234567-1"
"What's the next step?"
"Show me demo data"
"Run risk assessment"
"Approve this case"
"Close the case"
```

### Status Transitions
```
New → InProgress → [Pending Documents | Under Review] → [Approved | Rejected] → Closed
```

---

**Need help?** Type "help" or "next step" in the chatbot.

**Report bugs:** Contact your administrator or support team.

**Last updated:** 2026-07-23
