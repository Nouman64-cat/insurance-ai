import re

with open('frontend/components/Sidebar.tsx', 'r') as f:
    content = f.read()

# We need to find the start and end of NAV_ITEMS
start_marker = "const NAV_ITEMS = ["
end_marker = "] as const;"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker, start_idx)

if start_idx == -1 or end_idx == -1:
    print("Could not find NAV_ITEMS")
    exit(1)

nav_content = content[start_idx + len(start_marker):end_idx]

# Split into individual groups. Each group starts with "  {\n\n    group: "
# Let's find all occurrences of "  {" inside nav_content
groups = []
current_group_start = -1
bracket_count = 0

for i, char in enumerate(nav_content):
    if char == '{':
        if bracket_count == 0:
            if current_group_start != -1:
                # We shouldn't be here if it's formatted well, but let's just keep track
                pass
            current_group_start = i
        bracket_count += 1
    elif char == '}':
        bracket_count -= 1
        if bracket_count == 0:
            groups.append(nav_content[current_group_start:i+1])
            current_group_start = -1

# Now we have a list of strings, each is a `{ group: "...", ... }` object.
# Let's identify them by parsing the group name.
def get_group_name(g_str):
    m = re.search(r'group:\s*"([^"]+)"', g_str)
    if not m:
        # Check if it's commented out
        m2 = re.search(r'//\s*group:\s*"([^"]+)"', g_str)
        if m2:
            return m2.group(1)
        return "Unknown"
    return m.group(1)

parsed_groups = {get_group_name(g): g for g in groups}

# Desired order:
# 1. Main
# 2. Customer Management
# 3. Intelligence
# 4. Underwriting
# 5. Documents
# 6. Administration
# 7. User
# 8. Profile

order = [
    "Main",
    "Customer Management",
    "Intelligence",
    "Underwriting",
    "Documents",
    "Claims",           # Was commented out
    "Agents & Finance", # Was commented out
    "Administration",
    "User",
    "Profile"
]

# Ensure we have all groups
new_nav_content = "\n"
for name in order:
    if name in parsed_groups:
        new_nav_content += parsed_groups[name] + ",\n\n"

# Any remaining groups?
for name, g in parsed_groups.items():
    if name not in order:
        new_nav_content += g + ",\n\n"

new_content = content[:start_idx + len(start_marker)] + new_nav_content + content[end_idx:]

with open('frontend/components/Sidebar.tsx', 'w') as f:
    f.write(new_content)

print("Successfully reordered NAV_ITEMS")
