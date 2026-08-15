import { defineConfig, type DefaultTheme } from "vitepress";

const repository = "https://github.com/Tangerg/dougong";

function sidebarZh(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: "指南",
      collapsed: false,
      items: [
        { text: "快速开始", link: "/guide/getting-started" },
        { text: "核心概念", link: "/guide/concepts" },
        { text: "编写插件", link: "/guide/writing-plugins" },
        { text: "生命周期与资源", link: "/guide/lifetime" },
        { text: "事务与变更", link: "/guide/transactions" },
        { text: "响应式与观察", link: "/guide/reactive" },
        { text: "外部插件分发", link: "/guide/platform" },
      ],
    },
    {
      text: "参考",
      collapsed: false,
      items: [
        { text: "Core API 规范", link: "/reference/core-api" },
        { text: "整体架构", link: "/reference/architecture" },
        { text: "Platform 规范", link: "/reference/platform" },
        { text: "错误码", link: "/reference/errors" },
      ],
    },
    {
      text: "示例",
      collapsed: false,
      items: [{ text: "可执行示例", link: "/examples" }],
    },
  ];
}

function sidebarEn(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: "Guide",
      collapsed: false,
      items: [
        { text: "Getting started", link: "/en/guide/getting-started" },
        { text: "Core concepts", link: "/en/guide/concepts" },
        { text: "Writing plugins", link: "/en/guide/writing-plugins" },
        { text: "Lifetime and resources", link: "/en/guide/lifetime" },
        { text: "Transactions and change", link: "/en/guide/transactions" },
        { text: "Reactive and observation", link: "/en/guide/reactive" },
        { text: "External plugin delivery", link: "/en/guide/platform" },
      ],
    },
    {
      text: "Reference",
      collapsed: false,
      items: [
        { text: "Core API specification", link: "/en/reference/core-api" },
        { text: "Architecture", link: "/en/reference/architecture" },
        { text: "Platform specification", link: "/en/reference/platform" },
        { text: "Error codes", link: "/en/reference/errors" },
      ],
    },
    {
      text: "Examples",
      collapsed: false,
      items: [{ text: "Runnable examples", link: "/en/examples" }],
    },
  ];
}

export default defineConfig({
  title: "Dougong",
  base: "/dougong/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: "https://tangerg.github.io/dougong/" },
  head: [["meta", { name: "theme-color", content: "#9f3f2f" }]],

  locales: {
    root: {
      label: "简体中文",
      lang: "zh-CN",
      description: "纯 JavaScript/TypeScript 的能力组合与结构化生命周期内核。",
      themeConfig: {
        nav: [
          { text: "指南", link: "/guide/getting-started", activeMatch: "/guide/" },
          { text: "参考", link: "/reference/core-api", activeMatch: "/reference/" },
          { text: "示例", link: "/examples", activeMatch: "/examples" },
        ],
        sidebar: sidebarZh(),
        outline: { label: "本页内容", level: [2, 3] },
        docFooter: { prev: "上一页", next: "下一页" },
        editLink: {
          pattern: `${repository}/edit/main/docs/:path`,
          text: "在 GitHub 上编辑此页",
        },
        lastUpdated: { text: "最后更新于" },
        darkModeSwitchLabel: "外观",
        lightModeSwitchTitle: "切换到浅色模式",
        darkModeSwitchTitle: "切换到深色模式",
        sidebarMenuLabel: "菜单",
        returnToTopLabel: "返回顶部",
        langMenuLabel: "切换语言",
        footer: {
          message: "基于 MIT 许可证发布。",
          copyright: "Copyright © 2026-present Dougong contributors",
        },
      },
    },

    en: {
      label: "English",
      lang: "en-US",
      link: "/en/",
      description:
        "A capability composition and structured lifetime kernel for JavaScript/TypeScript.",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/en/guide/getting-started", activeMatch: "/en/guide/" },
          { text: "Reference", link: "/en/reference/core-api", activeMatch: "/en/reference/" },
          { text: "Examples", link: "/en/examples", activeMatch: "/en/examples" },
        ],
        sidebar: sidebarEn(),
        outline: { label: "On this page", level: [2, 3] },
        editLink: {
          pattern: `${repository}/edit/main/docs/:path`,
          text: "Edit this page on GitHub",
        },
        footer: {
          message: "Released under the MIT License.",
          copyright: "Copyright © 2026-present Dougong contributors",
        },
      },
    },
  },

  themeConfig: {
    socialLinks: [{ icon: "github", link: repository }],
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
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
      },
    },
  },
});
