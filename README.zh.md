<p align="center"><img src="assets/logo.svg" width="150" alt="dsh-effort-pilot logo：三档思考强度阶梯 + 自动驾驶表盘"></p>
<h1 align="center">dsh-effort-pilot</h1>

<p align="center"><a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4f8cff"></a></p>

> **一句话算账：** 思考 token 按输出价计费。把 60% 的简单工具轮从 `max` 降到 `low`，一个 30 步任务约省 **3 万输出 token**——OpenCode Go 的 V4.1 Flash 约 **2 美分/任务**、V4 Pro 约 **6 美分/任务**。

给 DeepSeek Harness（DSH）的**逐步思考强度驾驶仪**：简单工具轮自动降档、失败与重活自动升档，Agent 还能用 `set_effort` 自己调节——**从不换模型**，提示词前缀与缓存不受影响。

## 安装

```bash
dsh plugin --profile web add github:atlasmarkz/dsh-effort-pilot
# 或 npm：dsh plugin --profile web add dsh-effort-pilot
```

重启 DSH 生效。零依赖、无构建步骤。

## 它怎么决策

| 情况 | 动作 |
|---|---|
| 连续 2 轮简单小工具 | 降一档，不低于 `floor` |
| 工具失败、重载荷、混合重活 | 升一档（或升到 `high` / `max`） |
| 刚改过档 | 保持 `holdSteps` 轮，防横跳 |
| 上一轮以 `EMPTY_RESPONSE` / `TIMEOUT` 等结束 | 下一轮升一档（限流/鉴权/额度不算） |
| 你手动选了别的档位 | 本会话暂停自动；`set_effort auto` 交回驾驶仪 |

只改 `reasoningEffort`，provider/model 原样复制；档位从下一个模型步生效。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: effort-pilot
  config:
    floor: low          # 自动降档下限
    simpleStreak: 2     # 连续几轮简单轮后降一档
    holdSteps: 1        # 改档后保持几轮不再改
    allowUpgrade: true  # 允许失败/重活升档
    verbose: false      # 打印每次决策
```

完整键与默认值见 [`lib/config.js`](lib/config.js)（严格校验，写错键名挂载即报错）。

## 工具

- **`set_effort`** —— Agent 自己改档，必须给理由；`{ "level": "auto" }` 把控制权交回驾驶仪。
- **`effort_status`** —— 当前档位、模型可用档位、hold 剩余轮数、最近决策台账。

## 成本估算

30 步任务、`max` 每步约 2,500 思考 token、`low` 约 800，其中 60% 步骤降档 → 省 ≈ **30,600 输出 token**。按 OpenCode Go 目录价：Flash `$0.60/M` ≈ **$0.018/任务**，V4 Pro `$1.98/M` ≈ **$0.061/任务**；每天 20 个这样的任务 ≈ **$11 / $37 每月**。

通用公式：**降档步骤占比 × 每步省下的思考 token × 输出单价**。用 DSH 自带 token 统计 + `effort_status` 台账校准你自己的比例。

## 开发

```bash
node --test   # 40 个测试；受限沙箱里用 node --test --test-isolation=none
```

扩展点调研、被否决的方案、完整配置与路线图见 [DESIGN.md](DESIGN.md)；市场投稿条目见 [`submission/`](submission/)。

MIT
