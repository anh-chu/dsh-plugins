# dsh-advisor-plugin

[![npm version](https://img.shields.io/npm/v/dsh-advisor-plugin.svg)](https://www.npmjs.com/package/dsh-advisor-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D20-339933)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B32C3)

> DeepSeek Harness 的 advisor 策略模式插件：让便宜快速的执行模型继续跑主线，在关键节点把整段会话交给更强的审查模型，拿回 **plan / correction / stop signal** 后继续执行。

> **本地 fork（v0.2.6-local.1）**：上游 0.2.6 面向 DSH 0.1.5-rc.x，在 0.2.0-rc.2 上
> 浏览器半无法激活（`inject` 声明了 0.2 已移除的 `settingsScope` /
> `conversationEvents`，条目停在 pending），且 host 半会向已被 hooks 子系统接管
> 的 `hook/invoked` 写非法载荷。本目录是移植后的快照：设置卡片改走
> `configForms` + `settings.plugins.tab`，巡逻卡片因 0.2 无对应事件通道而移除，
> peer 范围放宽因此**不需要版本豁免**。安装：
>
> ```bash
> dsh plugin --profile web add file:/home/sil/dsh-plugins/dsh-advisor-plugin
> ```
>
> 细节与验证见 [COMPAT-0.2.0.md](./COMPAT-0.2.0.md)（`node test/compat-0.2.cjs`，18 条断言）。

`dsh-advisor-plugin` 解决的是一个结构性问题：**同一个模型既写代码又验代码，很容易“证明自己是对的”**。长链路 Coding Agent 常见的三类失效——自验证盲区、长程漂移、过早宣告完成——都可以用“独立第二意见”来缓解。

它提供两条互补通道：

- **显式咨询**：执行模型零参数调用 `advisor()`，整段会话与工具清单自动转发给审查模型；
- **自动巡逻**：每 N 步把会话快照发给审查模型，跑偏时在下一个请求注入纠偏，STOP 时要求执行模型停下向用户报告。

所有审查配置都在 DSH 设置页完成，不需要手改配置文件。

---

## 特性

- **总开关**：设置页一键启用/关闭；关闭时不注册 advisor 工具与升级守则，已保存的模型配置保留。
- **可折叠配置**：模型与推理档位、巡逻模式两个区块可分别收起/展开。
- **零参数 `advisor()` 工具**：调用即自动转发整段会话，模型不需要组织上下文。
- **plan / correction / stop 契约**：审查模型只做判断，不碰代码、不直接改状态。
- **compaction 感知**：转发的是 `session.deriveMessages()` 的真实模型可见面，而不是过期原始历史。
- **稳定的工具清单前缀**：按 agent scope 序列化，目标是命中 DeepSeek 前缀缓存。
- **巡逻模式**：步数 + 90 秒墙钟节流 + `patrolImmuneTurns` 冷却 + emission-guard 去重，防止过度打扰。
- **只读调查工具**：审查模型可先在工作区内 `search_files` / `read_file` 核实事实，再给建议。
- **失败隔离**：审查调用失败、超时、空正文、上下文溢出都不会炸掉执行模型的 turn。
- **双降级**：推理档位不支持时走模型默认档；上下文溢出时做配对安全截断后重试。
- **执行模型黑名单**：`disabledForModels` 支持 `model`、`provider/model`、`provider/model@effort` 三种语法。
- **未武装零成本**：没有配置审查模型时，工具和提示段都不注册。
- **可视化**：设置页卡片、`advisor()` 咨询卡片、巡逻裁决灰/琥珀/红三形态卡片。

---

## 架构

```text
src/                      # host 半（Node / Cordis 插件）
├── index.ts              # apply：组装工具/提示段/门控/巡逻/命令/设置
├── advisor-prompt.ts     # 咨询/巡逻两套系统提示 + 干预文本
├── config.ts             # schemastery schema + 武装解析 + 黑名单语法
├── tool.ts               # 零参 advisor 工具 + 专属卡片 + 结果信封
├── history.ts            # 工具清单 + deriveMessages + 尾部规则
├── llm-call.ts           # 审查调用 / sessionId 透传 / 降级 / 调查循环 / 回显剥离
├── patrol.ts             # 巡逻调度 / 裁决解析 / agent.inject 干预
├── patrol-event.ts       # 巡逻裁决写入会话事件
├── emission-guard.ts     # 归一化 / 空话过滤 / FIFO 去重
├── settings.ts           # settings 命名空间接入与活编辑
├── gating.ts             # 按 agent 隐藏 advisor 工具
├── prompt-section.ts     # 升级守则提示段
├── command.ts            # /advisor 命令
└── client/               # 浏览器半
    ├── index.ts          # 注册设置卡片 / 工具行 / 巡逻卡片
    ├── controller.ts     # 设置暂存编辑 + 模型目录
    ├── AdvisorCard.tsx   # 设置页卡片
    ├── AdvisorToolRow.tsx
    ├── PatrolNodeView.tsx
    ├── patrol-chat.ts
    ├── locales.ts
    └── store.ts

docs/                     # 技术文章与架构图
scripts/                  # 本地开发辅助脚本
```

完整模块说明见 `docs/`。

---

## 安装

### 1. npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-advisor-plugin
```

安装后重启 `dsh web`。

### 2. 本地开发安装

```bash
git clone https://github.com/leeyoung1/dsh-advisor-plugin.git
cd dsh-advisor-plugin
npm install
./scripts/link-deps.sh
./scripts/mount.sh
```

`link-deps.sh` 会把本机 DSH 携带的官方包链接进 `node_modules`，供类型检查和测试使用；`mount.sh` 会构建并挂载到本地 web profile。

> 注意：`npm install` 会清掉手工链接的 `@deepseek-ai/*` 包，重装依赖后需要重新执行 `./scripts/link-deps.sh`。

### 3. Git 直接安装（开发）

```bash
dsh plugin --profile web add github:leeyoung1/dsh-advisor-plugin
```

---

## 快速开始

1. 打开 **设置 → 插件**，找到 **Advisor 审查模型** 卡片；
2. 选择一个比执行模型更强的审查模型，按需设置推理档位；
3. 按任务类型决定是否开启巡逻模式；
4. 保存后，执行模型在任务开始前、卡住时、宣告完成前会自动调用 `advisor()`。

也可以在会话里执行 `/advisor` 查看当前配置和可用 provider/model。

### 配置示例

`~/.dsh/settings.yaml`：

```yaml
advisor:
  enabled: true
  provider: example-provider
  model: reviewer-model
  effort: high
  patrolEnabled: true
  patrolEverySteps: 6
  patrolImmuneTurns: 3
  investigate: true
  disabledForModels:
    - deepseek-v4-pro
    - gpt-5.2@high
  guidelines: []
```

`provider` + `model` 齐备才会武装；未配置时 advisor 工具对模型不可见，零提示词成本。

---

## 两条通道

### 显式咨询

```text
执行模型 ──advisor()──▶ 上下文组装 ──▶ 审查模型
   ▲                                      │
   └──── plan / correction / stop ◀───────┘
```

适用时机：

- 实质性工作开始前；
- 反复卡住、方向不收敛时；
- 证据与建议矛盾时；
- 宣告完成前。

### 自动巡逻

```text
agent/request ──每 N 步──▶ 快照 ──▶ 审查模型
                                      │
                ON-TRACK / CORRECTION / STOP
                                      ▼
                    会话事件卡片 + agent.inject() 注入下一请求
```

巡逻不会打断在飞 turn，干预最早落在下一个模型请求。

---

## 依赖要求

- Node.js `^22.19` 或 `>=24`
- DeepSeek Harness（web profile）
- 已配置至少一个可用的 provider / model 作为审查模型

## 兼容性

- **目标 DSH**：`0.1.5-rc.1` / `0.1.5-rc.2`；不承诺更早的 rc / alpha 版本。
- **Node.js**：`^22.19` 或 `>=24`。
- **安装方式**：请使用 `dsh plugin --profile web add dsh-advisor-plugin`；裸 `npm install` 会撞 DSH 官方包的 peer 依赖，这不是插件本身的问题。

## 两条通道

### 显式咨询

```text
执行模型 ──advisor()──▶ 上下文组装 ──▶ 审查模型
   ▲                                      │
   └──── plan / correction / stop ◀───────┘
```

适用时机：

- 实质性工作开始前；
- 反复卡住、方向不收敛时；
- 证据与建议矛盾时；
- 宣告完成前。

### 自动巡逻

```text
agent/request ──每 N 步──▶ 快照 ──▶ 审查模型
                                      │
                ON-TRACK / CORRECTION / STOP
                                      ▼
                    会话事件卡片 + agent.inject() 注入下一请求
```

巡逻不会打断在飞 turn，干预最早落在下一个模型请求。

---

## 依赖要求

- Node.js `^22.19` 或 `>=24`
- DeepSeek Harness（web profile）
- 已配置至少一个可用的 provider / model 作为审查模型

## 兼容性

- **DSH 版本**：peer 范围覆盖 `0.1.0-rc.6`、`0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.3-alpha.1`；已在 `0.1.1-rc.2` 上实机验证。
- **配置向后兼容**：旧配置没有 `enabled` 字段时默认 `true`，不影响升级。
- **关闭总开关**：`enabled: false` 时保留已保存的模型配置，但不注册工具与升级守则。
- **安装方式**：请使用 `dsh plugin --profile web add dsh-advisor-plugin`；裸 `npm install` 会撞 DSH 官方包的 peer 依赖，这不是插件本身的问题。

开发验证：

```bash
npm run typecheck
npm test
npm run build
```

当前测试：**7 个测试文件、59 个用例通过**。

---

## 文档

- [文档索引](docs/README.md)
- [技术文章：DeepSeek Harness 插件实战：我给 Coding Agent 请了个“随车专家”](docs/advisor-deep-dive.md)
- [架构图](docs/diagrams/architecture.svg)
- [双通道时序图](docs/diagrams/advisor-dual-channel-sequence.svg)

---

## 设计取向

- **执行与判断分离**：执行模型负责推进，审查模型负责判断。
- **建议权不等于执行权**：advisor 只输出建议，不替执行模型做决定。
- **按需升级**：强模型只在关键节点出现。
- **防御性工程**：降级、截断、重试、防噪、冷却、失败隔离。
- **宿主原生**：复用 DSH 的模型路由、凭据、设置页、会话事件与 UI 槽位。

## 灵感来源

- [Anthropic: The advisor strategy](https://claude.com/blog/the-advisor-strategy)
- [oh-my-pi advisor/watchdog](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md)
- [rpiv-advisor](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor)

## 常见问题

### DSH Desktop 报 `cannot resolve package "dsh-advisor"`

这是 `0.2.1` 的旧 bundle patch 导致的：那个版本的 `cordis.patch.yml` 仍然引用旧包名 `dsh-advisor`。`0.2.2+` 已经改成 `dsh-advisor-plugin`。

1. 先从对应 profile 移除旧安装（DSH Desktop 通常是 `desktop` profile）：
   ```bash
   dsh plugin --profile desktop remove dsh-advisor
   dsh plugin --profile desktop remove dsh-advisor-plugin
   ```
2. 安装最新版本：
   ```bash
   dsh plugin --profile desktop add dsh-advisor-plugin@latest --registry=https://registry.npmjs.org
   ```
3. 验证 profile 组合结果：
   ```bash
   dsh --profile desktop --dump-config | grep -A3 dsh-advisor
   ```
   期望看到：
   ```text
   # == dsh-advisor-plugin
   - id: dsh-advisor-plugin
     name: dsh-advisor-plugin
   ```
4. 如果 profile 的 `cordis.patch.yml` 里还残留 `- id: dsh-advisor` / `name: dsh-advisor` 行，删掉那一行再重启。


## License

[MIT](LICENSE)
