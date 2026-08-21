import { theme } from "antd"

// 2026-08-21 从 darkAlgorithm 切到 defaultAlgorithm：整站由深蓝玻璃拟态
// 改为「工程蓝图」浅色。algorithm 换了之后 antd 会重新推演全部派生色，
// 所以种子必须与 index.css 的 :root token 同源，否则组件与页面会分家。
//
// borderRadius 从 18 收到 5：18px 是糖果圆角，工程件要方。
// controlHeight 从 40 收到 34：工具界面密度要高，40 是营销页的尺寸。
export const antdTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    borderRadius: 5,
    colorPrimary: "#c2410c",
    colorInfo: "#c2410c",
    colorSuccess: "#2d6a4f",
    colorWarning: "#b45309",
    colorError: "#9f1239",
    colorText: "#1a1a18",
    colorTextSecondary: "rgba(26,26,24,0.56)",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBgLayout: "transparent",
    colorBorder: "#ddd9d2",
    colorBorderSecondary: "#e8e5df",
    controlHeight: 34,
    fontFamily:
      '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif',
    // 数字、ID、时间戳统一等宽，与 --font-mono 同源
    fontFamilyCode:
      '"SF Mono", "JetBrains Mono", "Roboto Mono", Menlo, Consolas, monospace',
  },
  // 组件级 token：antd 自带的圆角、阴影与预设标签色是另一套设计语言，
  // 不统一的话页面会一半工程图纸、一半 antd 默认。
  components: {
    Card: {
      borderRadiusLG: 5,
      boxShadowTertiary: "none",
      colorBorderSecondary: "#ddd9d2",
      paddingLG: 18,
    },
    Table: {
      borderRadius: 0,
      headerBg: "#f0eee9",
      headerColor: "rgba(26,26,24,0.56)",
      headerSplitColor: "transparent",
      rowHoverBg: "rgba(26,26,24,0.025)",
    },
    Tag: {
      // 预设色标签(success/processing 那些)是 antd 自己的绿蓝，
      // 与矿物色板冲突；圆角也收到 2px。
      borderRadiusSM: 2,
      defaultBg: "rgba(26,26,24,0.04)",
      defaultColor: "rgba(26,26,24,0.56)",
    },
    Button: { borderRadius: 5, primaryShadow: "none", defaultShadow: "none" },
    Input: { borderRadius: 5 },
    Select: { borderRadius: 5 },
    Modal: { borderRadiusLG: 6 },
    Alert: { borderRadiusLG: 5 },
    Progress: { defaultColor: "#c2410c" },
    Statistic: { contentFontSize: 26 },
  },
}
