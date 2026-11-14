import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
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
  // The raw text of the repository setup prompt, byte-identical to the source
  // page (CREW-3310): generated here so there is no second committed copy.
  buildEnd(siteConfig) {
    copyFileSync(join(siteConfig.srcDir, 'repo-setup-prompt.md'), join(siteConfig.outDir, 'repo-setup-prompt.md'))
  },
  rewrites: {
    'GETTING_STARTED.md': 'getting-started.md',
    'REPO_SPEC.md': 'repo-spec.md',
    'CONTRACT.md': 'contract.md',
  },
  themeConfig: {
    search: { provider: 'local' },
    nav: [
      { text: 'In brief', link: '/tldr' },
      { text: 'Install', link: '/install' },
      { text: 'Getting started', link: '/getting-started' },
      { text: 'Commands', link: '/commands' },
    ],
    sidebar: [
      { text: 'Crew in brief', link: '/tldr' },
      { text: 'Install', link: '/install' },
      { text: 'Getting started', link: '/getting-started' },
      { text: 'Command reference', link: '/commands' },
      { text: 'Host Passengers', link: '/host-passengers' },
      { text: 'Using the agent chat as a Passenger', link: '/passenger-chat' },
      { text: 'Periscope', link: '/periscope' },
      { text: 'Pooled instances', link: '/pool-member' },
      { text: 'The repo spec (.crew.yaml)', link: '/repo-spec' },
      { text: 'Repository setup prompt', link: '/repo-setup-prompt' },
      { text: 'The contract', link: '/contract' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/rightdesign/crew' }],
  },
})
