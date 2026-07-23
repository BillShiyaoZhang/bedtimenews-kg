import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "历史经纬｜睡前消息知识图谱",
  description:
    "从实体进入新闻历史，在时间线上检索事件前后关联，并审查每一条知识图谱关系的证据。",
  applicationName: "历史经纬",
  keywords: ["睡前消息", "知识图谱", "Ontology", "新闻检索", "时间线"],
  openGraph: {
    title: "历史经纬｜睡前消息知识图谱",
    description: "一条新闻，放回时间里看。",
    type: "website",
    locale: "zh_CN",
    url: siteUrl,
    images: [
      {
        url: `${siteUrl}/og.png`,
        width: 1734,
        height: 907,
        alt: "历史经纬：一条新闻，放回时间里看。",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "历史经纬｜睡前消息知识图谱",
    description: "一条新闻，放回时间里看。",
    images: [`${siteUrl}/og.png`],
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
