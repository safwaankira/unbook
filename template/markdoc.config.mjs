import { defineMarkdocConfig, component } from '@astrojs/markdoc/config';
import starlightMarkdoc from '@astrojs/starlight-markdoc';

const preset = starlightMarkdoc();
export default defineMarkdocConfig({
  extends: [preset],
  tags: {
    video: {
      render: component('./src/components/Video.astro'),
      selfClosing: true,
      attributes: { src: { type: String, required: true }, title: { type: String } },
    },
  },
  nodes: {
    // `process=false` on code fences keeps `{% %}` inside code samples literal.
    fence: {
      ...preset.nodes.fence,
      attributes: { ...preset.nodes.fence.attributes, process: { type: Boolean, render: false, default: true } },
    },
  },
});
