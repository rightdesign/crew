import { defineConfig } from 'vitepress'

// The source root is `docs/`. The existing upper-case files keep their names
// (other docs and tickets link to them); `rewrites` publishes them at stable
// lower-case paths, which is what the `crew connect` wizard and the Getting
// started View link to — never change a published path without a redirect.
export default defineConfig({
  title: 'crew',
  description: 'A standing team of headless agents that works a Tablation board',
  cleanUrls: true,
  srcExclude: ['MIGRATION.md'],
  rewrites: {
    'GETTING_STARTED.md': 'getting-started.md',
    'REPO_SPEC.md': 'repo-spec.md',
    'CONTRACT.md': 'contract.md',
  },
  themeConfig: {
    search: { provider: 'local' },
    nav: [
      { text: 'Getting started', link: '/getting-started' },
      { text: 'Commands', link: '/commands' },
    ],
    sidebar: [
      { text: 'Getting started', link: '/getting-started' },
      { text: 'Command reference', link: '/commands' },
      { text: 'Host Passengers', link: '/host-passengers' },
      { text: 'Using the agent chat as a Passenger', link: '/passenger-chat' },
      { text: 'The repo spec (.crew.yaml)', link: '/repo-spec' },
      { text: 'The contract', link: '/contract' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/rightdesign/crew' }],
  },
})
