import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'MeshtasticForeman',
  description: 'Self-hosted dashboard and API for Meshtastic mesh networks',
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Roadmap', link: '/guide/roadmap' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Full API Contract', link: '/api' },
          ],
        },
      ],
    },
  },
})