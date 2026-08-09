import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Home Robot",
  description: "由 API 整理记忆、日记与来信的中文陪伴空间。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
