import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'MeshtasticForeman',
  description: 'Self-hosted dashboard and API for Meshtastic mesh networks',
  appearance: true,
  ignoreDeadLinks: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]
  ],
  themeConfig: {
    logo: '/logo.svg',
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
    socialLinks: [
      { icon: 'github', link: 'https://github.com/SupremeLordCommander/MeshtasticForeman' }
    ],
    footer: {
      message: 'Released under MIT License',
      copyright: 'Copyright © 2026 SupremeLordCommander'
    },
  },
})