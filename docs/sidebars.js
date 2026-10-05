/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  mainSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Platform',
      collapsed: false,
      items: ['architecture', 'stack', 'services', 'data-flow', 'db-schemas'],
    },
    {
      type: 'category',
      label: 'Underwriting & Policies',
      collapsed: false,
      items: ['policy-lifecycle', 'cases', 'artifacts', 'fraud-layer'],
    },
    {
      type: 'category',
      label: 'AI',
      collapsed: false,
      items: ['chat-agent', 'llm-providers'],
    },
    'client-apps',
    'contributing',
  ],
};

module.exports = sidebars;
