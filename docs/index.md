---
layout: home
title: Dougong
titleTemplate: false
description: 纯 JavaScript/TypeScript 的能力组合与结构化生命周期内核。
hero:
  name: Dougong
  text: 组合出应用，而不是堆叠框架
  tagline: 用少量正交原子组织能力、依赖、变化与结构化生命周期。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 阅读 API 设计
      link: /api-design.zh-CN
features:
  - title: 组合优于继承
    details: Service、Extension、Event 与 Lifetime 保持正交，高层能力只通过公开协议组合。
  - title: 显式优于隐式
    details: 依赖、身份、所有权和运行期选择都写在明确的位置，不依赖环境猜测。
  - title: 一种语义，一条路径
    details: 高层语法糖机械编译到 canonical ChangeSet，不复制事务、依赖图或资源状态机。
---

## Dougong 是什么

Dougong（斗拱）是一个纯 JavaScript/TypeScript 的能力组合与结构化生命周期内核。它面向需要动态插件、宿主能力、原子更新和可靠资源释放的应用，但不把应用绑进一套 UI、IoC 或响应式框架。

Core 由几种职责单一的原子组成：

- **Service**：实例期稳定的能力与显式依赖。
- **Extension**：可动态增删的开放贡献集合。
- **Event**：已经发生、不会保存的瞬时事实。
- **Lifetime**：任务、订阅、贡献与清理的结构化所有权。
- **Plugin / Application**：把这些原子组织成可验证、可回滚的运行图。

## 从哪里开始

1. [快速开始](./guide/getting-started.md)运行仓库和第一个 Service 示例。
2. [可执行示例](./examples.md)从基础原子逐步走到 Planet、Lynx、声明式计划与模块图 HMR。
3. [Core API 设计](./api-design.zh-CN.md)是公共语义的规范来源。
4. [整体架构](./architecture.zh-CN.md)与 [Platform 设计](./platform-design.zh-CN.md)解释分层和外部插件边界。

> Dougong 仍处于早期开发阶段。当前优先保证模型正确、API 一致和可执行证据完整，暂不承诺向后兼容。
