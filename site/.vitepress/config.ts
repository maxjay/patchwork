import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'patchwork',
  description: 'A JSON editing engine with base/draft, diff, undo, and scoped lenses.',
  base: '/patchwork/',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/' },
      { text: 'Arrays', link: '/arrays' },
      { text: 'API', link: '/api' },
      { text: 'Playground', link: '/playground' },
    ],

    sidebar: [
      { text: 'Guide', link: '/' },
      { text: 'Array diffing', link: '/arrays' },
      { text: 'API reference', link: '/api' },
      { text: 'Playground', link: '/playground' },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/maxjay/patchwork' },
    ],

    footer: {
      message: 'Released under the Apache-2.0 License.',
    },

    search: { provider: 'local' },
  },
})
