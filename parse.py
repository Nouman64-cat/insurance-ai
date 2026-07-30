import re

def find_unclosed_tags(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Remove all string literals, comments and expressions to simplify
    # This is a bit tricky in JSX. Let's just find all tags.
    
    tags = []
    # match `<Tag`, `</Tag>`, `<Tag ... />`
    # We will ignore <, <=, etc. by requiring a valid tag name.
    pattern = re.compile(r'</?([a-zA-Z0-9_]+)([^>]*?)>')
    
    for m in pattern.finditer(content):
        full_tag = m.group(0)
        tag_name = m.group(1)
        inner = m.group(2)
        
        # Skip self-closing tags
        if full_tag.endswith('/>'):
            continue
            
        # Ignore common non-JSX things if they accidentally match
        
        if full_tag.startswith('</'):
            if tags and tags[-1][0] == tag_name:
                tags.pop()
            else:
                print(f"Mismatch at {full_tag} - Expected {tags[-1][0] if tags else 'nothing'}")
        else:
            tags.append((tag_name, full_tag, m.start()))

    print("Remaining unclosed tags:")
    for t in tags:
        line_num = content[:t[2]].count('\n') + 1
        print(f"Line {line_num}: {t[1]}")

find_unclosed_tags("frontend/components/CopilotInterface.tsx")
