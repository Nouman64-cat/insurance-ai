import re

with open('frontend/components/Sidebar.tsx', 'r') as f:
    content = f.read()

def extract_link(label):
    # Find the link block for a specific label
    pattern = r'\{\s*href:\s*"[^"]*",\s*label:\s*"' + label + r'",[\s\S]*?(?:\},|\}(?=\s*\]))'
    m = re.search(pattern, content)
    if m:
        return m.group(0)
    return None

acq_link = extract_link("Acquisition Sources")

if not acq_link:
    print("Could not find Acquisition Sources link.")
    exit(1)

# Remove the trailing comma from the extracted blocks if it exists, to normalize it
if acq_link.endswith(','): acq_link = acq_link[:-1]

# Delete it from its original location
new_content = re.sub(r'\{\s*href:\s*"[^"]*",\s*label:\s*"Acquisition Sources",[\s\S]*?(?:\},|\}(?=\s*\]))', '', content)

# Now add it to the "Main" group right after Underwriting.
# Find the end of the "Main" links array.
main_group_pattern = r'(group:\s*"Main",\s*links:\s*\[[\s\S]*?\{[\s\S]*?label:\s*"Underwriting"[\s\S]*?\},)'
m_main = re.search(main_group_pattern, new_content)

if m_main:
    injection = f"{m_main.group(1)}\n{acq_link},"
    new_content = new_content[:m_main.start()] + injection + new_content[m_main.end():]
else:
    print("Could not find Main group or Underwriting in Main group")
    exit(1)

with open('frontend/components/Sidebar.tsx', 'w') as f:
    f.write(new_content)

print("Restructured NAV_ITEMS successfully.")
