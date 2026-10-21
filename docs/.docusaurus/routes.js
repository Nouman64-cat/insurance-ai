import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/insurance-ai/__docusaurus/debug',
    component: ComponentCreator('/insurance-ai/__docusaurus/debug', '01d'),
    exact: true
  },
  {
    path: '/insurance-ai/__docusaurus/debug/config',
    component: ComponentCreator('/insurance-ai/__docusaurus/debug/config', 'e04'),
    exact: true
  },
  {
    path: '/insurance-ai/__docusaurus/debug/content',
    component: ComponentCreator('/insurance-ai/__docusaurus/debug/content', '2dd'),
    exact: true
  },
  {
    path: '/insurance-ai/__docusaurus/debug/globalData',
    component: ComponentCreator('/insurance-ai/__docusaurus/debug/globalData', '22e'),
    exact: true
  },
  {
    path: '/insurance-ai/__docusaurus/debug/metadata',
    component: ComponentCreator('/insurance-ai/__docusaurus/debug/metadata', '4e9'),
    exact: true
  },
  {
    path: '/insurance-ai/__docusaurus/debug/registry',
    component: ComponentCreator('/insurance-ai/__docusaurus/debug/registry', 'b1d'),
    exact: true
  },
  {
    path: '/insurance-ai/__docusaurus/debug/routes',
    component: ComponentCreator('/insurance-ai/__docusaurus/debug/routes', '027'),
    exact: true
  },
  {
    path: '/insurance-ai/',
    component: ComponentCreator('/insurance-ai/', '7ae'),
    routes: [
      {
        path: '/insurance-ai/',
        component: ComponentCreator('/insurance-ai/', '78d'),
        routes: [
          {
            path: '/insurance-ai/',
            component: ComponentCreator('/insurance-ai/', '5d5'),
            routes: [
              {
                path: '/insurance-ai/architecture',
                component: ComponentCreator('/insurance-ai/architecture', '152'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/artifacts',
                component: ComponentCreator('/insurance-ai/artifacts', '2e6'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/cases',
                component: ComponentCreator('/insurance-ai/cases', '253'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/chat-agent',
                component: ComponentCreator('/insurance-ai/chat-agent', 'e4b'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/client-apps',
                component: ComponentCreator('/insurance-ai/client-apps', '6ef'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/commission-earnings',
                component: ComponentCreator('/insurance-ai/commission-earnings', '670'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/contributing',
                component: ComponentCreator('/insurance-ai/contributing', '7b1'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/data-flow',
                component: ComponentCreator('/insurance-ai/data-flow', '086'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/db-schemas',
                component: ComponentCreator('/insurance-ai/db-schemas', '596'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/fraud-layer',
                component: ComponentCreator('/insurance-ai/fraud-layer', 'dcc'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/LLM_COST_ESTIMATE',
                component: ComponentCreator('/insurance-ai/LLM_COST_ESTIMATE', 'c08'),
                exact: true
              },
              {
                path: '/insurance-ai/llm-providers',
                component: ComponentCreator('/insurance-ai/llm-providers', '9ce'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/policy-lifecycle',
                component: ComponentCreator('/insurance-ai/policy-lifecycle', '931'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/services',
                component: ComponentCreator('/insurance-ai/services', '50f'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/stack',
                component: ComponentCreator('/insurance-ai/stack', '91b'),
                exact: true,
                sidebar: "mainSidebar"
              },
              {
                path: '/insurance-ai/',
                component: ComponentCreator('/insurance-ai/', '983'),
                exact: true,
                sidebar: "mainSidebar"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
