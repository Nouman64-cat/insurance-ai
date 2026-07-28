const fs = require("fs");
let content = fs.readFileSync("frontend/components/CopilotInterface.tsx", "utf-8");

content = content.replace(
  `  const text = (lastMessage.text || "").toLowerCase();`,
  `  const text = (lastMessage.text || "").toLowerCase();\n  \n  if (text.includes("missing documents") || (text.includes("upload") && text.includes("document"))) {\n    const isCNIC = text.includes("cnic");\n    const isMed = text.includes("medical");\n    const isSalary = text.includes("salary");\n    const actions = [];\n    if (isCNIC || (!isCNIC && !isMed && !isSalary)) actions.push({ label: "Upload CNIC", actionType: "upload", payload: JSON.stringify({ document_type: "CNIC" }) });\n    if (isMed || (!isCNIC && !isMed && !isSalary)) actions.push({ label: "Upload Medical Report", actionType: "upload", payload: JSON.stringify({ document_type: "Medical Report" }) });\n    if (isSalary || (!isCNIC && !isMed && !isSalary)) actions.push({ label: "Upload Salary Slip", actionType: "upload", payload: JSON.stringify({ document_type: "Salary Slip" }) });\n    actions.push({ label: "I have uploaded them", actionType: "submit", payload: "I have uploaded the documents. Please check and proceed." });\n    return actions;\n  }`
);

content = content.replace(
  `<ReactMarkdown>{msg.text}</ReactMarkdown>\n                                </div>`,
  `<ReactMarkdown>{msg.text}</ReactMarkdown>\n                                  {msg.steps && msg.steps.length > 0 && (\n                                    <div className="mt-4 mb-2 max-w-md">\n                                      <ProcessGraph steps={msg.steps} compact={true} />\n                                    </div>\n                                  )}\n                                </div>`
);

content = content.replace(
  `<ReactMarkdown>{msg.text}</ReactMarkdown>\n                          </div>`,
  `<ReactMarkdown>{msg.text}</ReactMarkdown>\n                          {msg.steps && msg.steps.length > 0 && (\n                            <div className="mt-4 mb-1">\n                              <ProcessGraph steps={msg.steps} compact={true} />\n                            </div>\n                          )}\n                        </div>`
);

fs.writeFileSync("frontend/components/CopilotInterface.tsx", content);
console.log("Patched CopilotInterface.tsx");
