import { theme } from "antd"

// darkAlgorithm 会对种子做颜色推演，不能把 `var(--x)` 当种子，
// 否则标题会被推成近黑。这里用与 :root token 同源的色值。
export const antdTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    borderRadius: 18,
    colorPrimary: "#4d8dff",
    colorBgContainer: "#141d33",
    colorBgElevated: "#141d33",
    colorBgLayout: "transparent",
    colorBorder: "rgba(148,180,255,0.14)",
    controlHeight: 40,
    fontFamily: '"SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif',
  },
}
