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
      { text: "Deutsch", link: "/de" },
      { text: "Español", link: "/es" },
      { text: "日本語", link: "/ja" },
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
          { text: "RevenueCat", link: "/revenuecat" },
          { text: "Labels and legal packs", link: "/labels" },
          { text: "History and source watch", link: "/history" },
          { text: "Native projects", link: "/native" },
          { text: "Live device check", link: "/live" },
          { text: "Pack registry", link: "/registry" },
          { text: "API and schema", link: "/stability" },
          { text: "Türkçe", link: "/tr" },
          { text: "Deutsch", link: "/de" },
          { text: "Español", link: "/es" },
          { text: "日本語", link: "/ja" },
        ],
      },
    ],
  },
});
