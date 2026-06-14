import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'patchwork',
  description: 'A JSON editing engine with base/draft, diff, undo, and scoped lenses.',
  base: '/patchwork/',
  head: [['link', { rel: 'icon', href: '/patchwork/favicon.ico' }]],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide' },
      { text: 'Arrays', link: '/arrays' },
      { text: 'API', link: '/api' },
      { text: 'Playground', link: '/playground' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting started', link: '/guide' },
          { text: 'Array diffing', link: '/arrays' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API', link: '/api' },
          { text: 'Playground', link: '/playground' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/maxjay/patchwork' },
    ],

    footer: {
      message: 'Released under the Apache-2.0 License.',
    },

    search: { provider: 'local' },
  },

  vite: {
    resolve: {
      alias: {
        '@engine': '../src/engine.ts',
      },
    },
  },
})
