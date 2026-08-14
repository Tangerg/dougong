import { defineConfig, type DefaultTheme } from "vitepress";

const repository = "https://github.com/Tangerg/dougong";

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: "开始",
    items: [
      { text: "项目介绍", link: "/" },
      { text: "快速开始", link: "/guide/getting-started" },
      { text: "可执行示例", link: "/examples" },
    ],
  },
  {
    text: "设计",
    items: [
      { text: "Core API 设计", link: "/api-design.zh-CN" },
      { text: "整体架构", link: "/architecture.zh-CN" },
      { text: "Platform 设计", link: "/platform-design.zh-CN" },
    ],
  },
];

export default defineConfig({
  lang: "zh-CN",
  title: "Dougong",
  description: "纯 JavaScript/TypeScript 的能力组合与结构化生命周期内核。",
  base: "/dougong/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: "https://tangerg.github.io/dougong/" },
  head: [["meta", { name: "theme-color", content: "#9f3f2f" }]],
  themeConfig: {
    nav: [
      { text: "指南", link: "/guide/getting-started" },
      { text: "API 设计", link: "/api-design.zh-CN" },
      { text: "架构", link: "/architecture.zh-CN" },
      { text: "示例", link: "/examples" },
    ],
    sidebar,
    socialLinks: [{ icon: "github", link: repository }],
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "搜索", buttonAriaLabel: "搜索文档" },
          modal: {
            displayDetails: "显示详细列表",
            resetButtonTitle: "清除查询",
            backButtonTitle: "关闭搜索",
            noResultsText: "没有找到结果",
            footer: {
              selectText: "选择",
              selectKeyAriaLabel: "回车",
              navigateText: "导航",
              navigateUpKeyAriaLabel: "上箭头",
              navigateDownKeyAriaLabel: "下箭头",
              closeText: "关闭",
              closeKeyAriaLabel: "Esc",
            },
          },
        },
      },
    },
    outline: { label: "本页内容", level: [2, 3] },
    docFooter: { prev: "上一页", next: "下一页" },
    editLink: {
      pattern: `${repository}/edit/main/docs/:path`,
      text: "在 GitHub 上编辑此页",
    },
    lastUpdated: { text: "最后更新于" },
    darkModeSwitchLabel: "外观",
    sidebarMenuLabel: "菜单",
    returnToTopLabel: "返回顶部",
    footer: {
      message: "基于 MIT 许可证发布。",
      copyright: "Copyright © 2026-present Dougong contributors",
    },
  },
});
