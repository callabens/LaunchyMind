import { defineConfig } from "vitepress";

export default defineConfig({
  title: "LaunchyMind",
  description: "Local pre-release checks for mobile apps. The rule engine decides the verdict.",
  base: "/LaunchyMind/",
  lang: "en",
  themeConfig: {
    nav: [
      { text: "Start", link: "/" },
      { text: "CLI", link: "/cli" },
      { text: "Rules", link: "/rules" },
      { text: "Türkçe", link: "/tr" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Install and quick start", link: "/" },
          { text: "CLI", link: "/cli" },
          { text: "MCP", link: "/mcp" },
          { text: "Skill", link: "/skill" },
          { text: "GitHub Action", link: "/github-action" },
          { text: "Rules and sources", link: "/rules" },
          { text: "Writing a pack", link: "/writing-a-pack" },
          { text: "Approval flow", link: "/approval" },
          { text: "Store console", link: "/connect" },
          { text: "Labels and legal packs", link: "/labels" },
          { text: "Türkçe", link: "/tr" },
        ],
      },
    ],
  },
});
