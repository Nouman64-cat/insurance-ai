const { z } = require("zod");
const { zodToJsonSchema } = require("zod-to-json-schema");
const { tool } = require("@langchain/core/tools");

const navigateToPageTool = tool(
  async (args) => {
    return JSON.stringify({ success: true, message: `Navigating to ${args.page_name}` });
  },
  {
    name: "navigate_to_page",
    description: "Navigates the user to a specific section",
    schema: z.object({
      page_name: z.enum(["dashboard"])
    }),
  }
);

console.log("t.schema:", navigateToPageTool.schema);
console.log("zodToJsonSchema(t.schema):", JSON.stringify(zodToJsonSchema(navigateToPageTool.schema)));
