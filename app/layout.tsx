import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "历史经纬｜睡前消息知识图谱",
  description:
    "搜索睡前消息新闻存档，或按事件、主体、地点、主题、命名对象与时间组合检索。",
  applicationName: "历史经纬",
  keywords: [
    "睡前消息",
    "知识图谱",
    "Ontology",
    "新闻检索",
    "事件检索",
  ],
  openGraph: {
    title: "历史经纬｜睡前消息知识图谱",
    description: "关键词搜索，或按事件、主体、地点与主题组合检索。",
    type: "website",
    locale: "zh_CN",
    url: siteUrl,
    images: [
      {
        url: `${siteUrl}/og-v2.png`,
        width: 1733,
        height: 908,
        alt: "历史经纬：一条新闻，放回时间里看。",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "历史经纬｜睡前消息知识图谱",
    description: "关键词搜索，或按事件、主体、地点与主题组合检索。",
    images: [`${siteUrl}/og-v2.png`],
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f3efe5",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
