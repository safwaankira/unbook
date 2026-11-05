// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import markdoc from '@astrojs/markdoc';

export default defineConfig({
  site: __SITE__, // set to your new docs domain
  integrations: [
    markdoc(),
    starlight({
      title: __TITLE__,
      logo: __LOGO__,
      favicon: __FAVICON__,
      customCss: ['./src/styles/custom.css'],
      social: __SOCIAL__,
      head: __HEAD__,
      lastUpdated: false,
      pagination: true,
      sidebar: __SIDEBAR__,
    }),
  ],
});
