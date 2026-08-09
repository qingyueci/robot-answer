# Supabase 会话保存

1. 在 Supabase 项目中启用 **Authentication → Anonymous Sign-Ins**。
2. 在 SQL Editor 执行 `migrations/20260723000000_chat_sessions.sql`。
3. 将项目 URL 和 Publishable Key 写入仓库根目录 `.env.local`：

```env
NEXT_PUBLIC_SUPABASE_URL=https://你的项目.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
```

不要把 `service_role` 密钥放进 `NEXT_PUBLIC_*` 变量。浏览器只使用 Publishable Key，数据访问由匿名登录后的 JWT 和 RLS 限制。
