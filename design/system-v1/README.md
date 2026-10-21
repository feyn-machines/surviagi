# openaiwill / Design system v1

[打开视觉样本](preview.html) · [阅读规范](../../DESIGN.md)

这是可复用资源包，已确认的 Tensorlake 风格在这里被整理为 openaiwill 的规则。项目名称与域名于 2026-09-12 确认为 openaiwill / openaiwill.com。现有样本中的 AgentHowTo 为历史展示文案；`--ah-*` 与 `.ah-root` 保持为既有技术接口。产品业务页面尚未接入。`reference/` 中的第三方成品与这里重新编写的实现分开管理。

| 文件 | 用途 |
| --- | --- |
| `tokens.json` | 颜色、排版、间距、线条、动效的唯一数值来源，含继承与改动说明 |
| `styles/tokens.css` | 自动生成的 `--ah-*` 变量，附着于 `.ah-root`，按需导入 |
| `styles/fonts.css` + `fonts/` | 本地 Inter Tight / JetBrains Mono 变量字体、许可与来源校验 |
| `styles/components.css` | 框架无关 CSS 基元；组件状态见样本页 |
| `assets/signal-strips.svg` | 原创品牌条带构图，纯装饰、非统计图、非最终 Logo |
| `assets/evidence-flow.svg` / `evidence-flow-mobile.svg` | 原创来源 → 事件 → 状态估计流程示意；手机使用纵向图形，含待审关系 |
| `assets/scenario-range.svg` / `scenario-range-mobile.svg` | 桌面和手机的虚构情景区间样本；与正式数据无关 |
| `preview.template.html` → `preview.html` | 源模板和生成的离线规范样本：图形、色板、字体、控件、表格和减弱动画 |
| `prompts/` | 局部探索、开发、独立截图审阅模板 |
| `qa.md` | 验收方法与最近实测记录 |
| `manifest.json` | 可复用资产来源、用途与归属 |

## 使用

静态页面依次加载 `styles/tokens.css`、`styles/fonts.css`、`styles/components.css`，容器使用 `.ah-root`。`preview.html` 展示完整可复制标记，配套 `preview.css/js` 仅服务规范展示，不作为业务组件导入。

Next.js 页面迁移时，在相应入口按同样顺序 import 三份 CSS（相对路径随文件位置调整）。局部包裹 `.ah-root` 以隔离旧样式；页面布局用项目现有 CSS 或 CSS Modules。字体 URL 相对于 `fonts.css`；交由构建工具处理，保留字体许可证。根据项目当前 Next 文档检查 CSS 加载顺序，迁移后重新做生产构建与浏览器验证。

编辑 token 或生成图形后运行 `pnpm design:build`；`pnpm design:check` 验证生成文件、资源引用、许可摘要和关键配色。SVG 的几何在 `scripts/build-design-system.mjs` 中维护，颜色继承 token；文本值只是标明的样本。

初次使用可直接用浏览器打开 `preview.html`。在项目根目录运行 `python3 -m http.server 61481 --bind 127.0.0.1`，再打开 `http://127.0.0.1:61481/design/system-v1/preview.html`；这样文档相对链接也能访问。
