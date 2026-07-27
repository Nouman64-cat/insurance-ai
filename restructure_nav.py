import re
import json

with open('frontend/components/Sidebar.tsx', 'r') as f:
    content = f.read()

# We can manipulate the file safely by using string replacements or ast, but regex is easier if careful.
# Since it's TSX, I'll extract the link objects for Leads, Proposal, and Underwriting.

def extract_link(label):
    # Find the link block for a specific label
    pattern = r'\{\s*href:\s*"[^"]*",\s*label:\s*"' + label + r'",[\s\S]*?(?:\},|\}(?=\s*\]))'
    m = re.search(pattern, content)
    if m:
        return m.group(0)
    return None

leads_link = extract_link("Leads")
proposal_link = extract_link("Proposal")
underwriting_link = extract_link("Underwriting")

if not leads_link or not proposal_link or not underwriting_link:
    print("Could not find one of the links.")
    exit(1)

# Remove the trailing comma from the extracted blocks if it exists, to normalize it
if leads_link.endswith(','): leads_link = leads_link[:-1]
if proposal_link.endswith(','): proposal_link = proposal_link[:-1]
if underwriting_link.endswith(','): underwriting_link = underwriting_link[:-1]

# Delete them from their original locations
new_content = re.sub(r'\{\s*href:\s*"[^"]*",\s*label:\s*"Leads",[\s\S]*?(?:\},|\}(?=\s*\]))', '', content)
new_content = re.sub(r'\{\s*href:\s*"[^"]*",\s*label:\s*"Proposal",[\s\S]*?(?:\},|\}(?=\s*\]))', '', new_content)
# Be careful with Underwriting, as the group is also named Underwriting.
new_content = re.sub(r'\{\s*href:\s*"[^"]*",\s*label:\s*"Underwriting",[\s\S]*?(?:\},|\}(?=\s*\]))', '', new_content)

# Clean up empty groups if necessary.
# Let's see if any group became empty. "Customer Management" still has "Policy Holders".
# "Intelligence" still has "Live Evaluation", etc.
# "Underwriting" still has "Applications".

# Now add them to the "Main" group.
# Find the end of the "Main" links array.
main_group_pattern = r'(group:\s*"Main",\s*links:\s*\[[\s\S]*?\{[\s\S]*?label:\s*"Dashboard"[\s\S]*?\},)'
m_main = re.search(main_group_pattern, new_content)

if m_main:
    injection = f"{m_main.group(1)}\n{leads_link},\n{proposal_link},\n{underwriting_link},"
    new_content = new_content[:m_main.start()] + injection + new_content[m_main.end():]
else:
    print("Could not find Main group")
    exit(1)

with open('frontend/components/Sidebar.tsx', 'w') as f:
    f.write(new_content)

print("Restructured NAV_ITEMS successfully.")
