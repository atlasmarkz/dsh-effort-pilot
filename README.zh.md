<p align="center"><img src="assets/logo.svg" width="150" alt="dsh-effort-pilot logo：三档思考强度阶梯 + 自动驾驶表盘"></p>
<h1 align="center">dsh-effort-pilot</h1>

<p align="center"><a href="https://github.com/atlasmarkz/dsh-effort-pilot/releases"><img alt="release" src="https://img.shields.io/github/v/release/atlasmarkz/dsh-effort-pilot"></a> <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4f8cff"></a></p>

> **一句话算账：** 思考 token 按输出价计费。**实测**（OpenCode Go V4.1 Flash，本机 DSH）：同一任务把档位从 `max` 降到 `low`，输出 token 约 **-36%**、解码耗时约 **-38%**、整轮耗时约 **-33%**；30 步任务量级约省 0.3 万–1 万输出 token，折算 Flash 约 **0.2–0.6 美分**、V4 Pro 约 **0.5–2 美分**。速度收益比省钱更明显；模型越贵、思考越重，省得越多。方法与原始数据见 [BENCHMARK.md](BENCHMARK.md)。

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

## 成本估算（实测）

本机实测（详见 [BENCHMARK.md](BENCHMARK.md)，n=2，网关噪声可见）：

- 推理任务：`max` → `low`，输出 token **3,700 → 2,362（-36%）**，解码 47.8s → 29.5s，整轮 71.4s → 47.6s；
- 机械任务：auto 降档后输出 token **1,216 → 763（-37%）**，解码 9.4s → 3.9s。

按 30 步任务折算：约省 **0.3 万–1 万输出 token**；OpenCode Go 目录价下 Flash 约 **$0.002–0.006**/任务，V4 Pro（输出 `$1.98/M`）约 **$0.005–0.020**。通用公式：**降档步骤占比 × 每步省下的思考 token × 输出单价**；用 DSH 自带 token 统计 + `effort_status` 台账校准你自己的比例。**速度提升比省钱更直接**（约 -33% 整轮耗时），模型越贵、思考越重，省钱越明显。

**质量**：修复失败测试与盲评代码审查两个任务，max / auto / low 各 2 次——修复任务三臂全部 6/6 通过（测试文件未被改），盲评得分 max 9.0 / auto 9.0 / low 10.0，无可测差异（n=2，详见 [BENCHMARK.md](BENCHMARK.md)）。

## 开发

```bash
node --test   # 40 个测试；受限沙箱里用 node --test --test-isolation=none
```

扩展点调研、被否决的方案、完整配置与路线图见 [DESIGN.md](DESIGN.md)；市场投稿条目见 [`submission/`](submission/)。

MIT
