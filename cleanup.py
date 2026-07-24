import re

with open("frontend/app/proposal/page.tsx", "r") as f:
    text = f.read()

# Remove unused state variables
cleanup_regex = r'^\s*const \[expandedOrgId, setExpandedOrgId\] = useState<string \| null>\(null\);\n^\s*const \[expandedPolicyId, setExpandedPolicyId\] = useState<string \| null>\(null\);\n^\s*const \[viewMode, setViewMode\] = useState<\'list\'\|\'grid\'>\(\'list\'\);\n^\s*const \[expandedFamilyGroupId, setExpandedFamilyGroupId\] = useState<string \| null>\(null\);\n^\s*const \[expandedFamilyPolicyId, setExpandedFamilyPolicyId\] = useState<string \| null>\(null\);\n\n^\s*const toggleOrgFolder = \(orgId: string\) => \{\n^\s*setExpandedOrgId\(\(prev\) => \(prev === orgId \? null : orgId\)\);\n^\s*setExpandedPolicyId\(null\);\n^\s*\};\n\n^\s*const togglePolicyFolder = \(policyId: string\) => \{\n^\s*setExpandedPolicyId\(\(prev\) => \(prev === policyId \? null : policyId\)\);\n^\s*\};\n\n^\s*const toggleFamilyGroupFolder = \(familyGroupId: string\) => \{\n^\s*setExpandedFamilyGroupId\(\(prev\) => \(prev === familyGroupId \? null : familyGroupId\)\);\n^\s*setExpandedFamilyPolicyId\(null\);\n^\s*\};\n\n^\s*const toggleFamilyPolicyFolder = \(familyPolicyId: string\) => \{\n^\s*setExpandedFamilyPolicyId\(\(prev\) => \(prev === familyPolicyId \? null : familyPolicyId\)\);\n^\s*\};\n'

text = re.sub(cleanup_regex, '  const [viewMode, setViewMode] = useState<\'list\'|\'grid\'>(\'list\');\n', text, flags=re.MULTILINE)

# If regex fails, let's just do it manually with string replace
text = text.replace("const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null);", "")
text = text.replace("const [expandedPolicyId, setExpandedPolicyId] = useState<string | null>(null);", "")
text = text.replace("const [expandedFamilyGroupId, setExpandedFamilyGroupId] = useState<string | null>(null);", "")
text = text.replace("const [expandedFamilyPolicyId, setExpandedFamilyPolicyId] = useState<string | null>(null);", "")
text = re.sub(r'const toggleOrgFolder = \(orgId: string\) => \{[\s\S]*?\};\n', '', text)
text = re.sub(r'const togglePolicyFolder = \(policyId: string\) => \{[\s\S]*?\};\n', '', text)
text = re.sub(r'const toggleFamilyGroupFolder = \(familyGroupId: string\) => \{[\s\S]*?\};\n', '', text)
text = re.sub(r'const toggleFamilyPolicyFolder = \(familyPolicyId: string\) => \{[\s\S]*?\};\n', '', text)

with open("frontend/app/proposal/page.tsx", "w") as f:
    f.write(text)
