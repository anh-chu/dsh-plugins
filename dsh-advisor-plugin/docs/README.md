# dsh-advisor-plugin 文档

本目录保存 `dsh-advisor-plugin` 的技术文章与架构图。

## 快速入口

| 文档 | 用途 |
| --- | --- |
| [DeepSeek Harness 插件实战：我给 Coding Agent 请了个“随车专家”](./advisor-deep-dive.md) | 技术文章：架构、设计理念、subagent 对比、实机验证 |
| [架构图 Mermaid](./diagrams/architecture.mmd) · [SVG](./diagrams/architecture.svg) | host / client / DSH 宿主能力分层架构 |
| [双通道时序图 Mermaid](./diagrams/advisor-dual-channel-sequence.mmd) · [SVG](./diagrams/advisor-dual-channel-sequence.svg) | 显式咨询 + 巡逻模式完整时序 |

## 目录结构

```text
docs/
├── README.md
├── advisor-deep-dive.md
└── diagrams/
    ├── architecture.mmd
    ├── architecture.svg
    ├── advisor-dual-channel-sequence.mmd
    ├── advisor-dual-channel-sequence.svg
    └── generated/              # AI 生成的文章配图
```
