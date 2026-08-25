import sys

with open('services/tenant-service/migrate.py', 'r') as f:
    content = f.read()

import re

# We want to replace the conflict markers with the combined version.
# The regex will find the block from <<<<<<< HEAD to >>>>>>> dd7588e...
conflict_pattern = re.compile(
    r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>>[^\n]*\n',
    re.DOTALL
)

def replacer(match):
    head_content = match.group(1)
    dd_content = match.group(2)
    # Put dd_content (v44) before head_content (v45)
    return f"{dd_content}\n{head_content}\n"

new_content = conflict_pattern.sub(replacer, content)

with open('services/tenant-service/migrate.py', 'w') as f:
    f.write(new_content)

print("Conflict resolved.")
