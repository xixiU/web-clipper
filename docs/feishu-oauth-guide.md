# 飞书剪藏插件后端 (Cloudflare Worker) 部署指南

本指南将帮助你部署一个基于 Cloudflare Workers 的轻量级后端服务，用于处理飞书 (Feishu/Lark) 的 OAuth 2.0 授权流程。配合 Web Clipper 插件，你可以将网页内容直接保存到自己的飞书个人空间。

## 为什么需要这个 Worker？

飞书的开放平台要求 OAuth 授权必须通过服务器端交换 Token（出于安全考虑，Client Secret 不能暴露在前端）。
Cloudflare Workers 提供了一个免费、高性能且无需维护服务器的解决方案，非常适合个人用户托管此类鉴权服务。

## 准备工作

1.  一个 [Cloudflare](https://www.cloudflare.com/) 账号（免费版即可）。
2.  一个 [飞书](https://www.feishu.cn/) 账号（需注册一个个人组织，免费）。

---

## 第一步：创建飞书应用

1.  登录 [飞书开放平台](https://open.feishu.cn/app)。
2.  点击 **"创建企业自建应用"**。
3.  填写应用名称（如 "Web Clipper"）和描述，点击创建。
4.  在应用详情页，左侧菜单选择 **"凭证与基础信息"**。
    *   记录下 **App ID** 和 **App Secret**，稍后会用到。
5.  左侧菜单选择 **"开发配置" -> "安全设置"**。
    *   在 **"重定向 URL"** 中，添加你的 Worker URL（格式为 `https://<你的Worker名>.<你的子域名>.workers.dev/callback`）。
    *   *注意：如果你还没部署 Worker，可以先跳过这一步，等部署完拿到 URL 后再回来填。*
6.  左侧菜单选择 **"权限管理"**。
    *   切换到 **"应用身份"** 标签页（其实这里主要是为了开通 API 能力，User Token 的权限通常是动态请求的，但建议预先配置）。
    *   搜索并开通以下权限：
        *   `docx:document:user_group_read_write` (查看、评论、编辑和管理云空间所有文件)
        *   `drive:drive:readonly` (查看云空间目录)
        *   `drive:drive` (查看、评论、编辑和管理云空间所有文件)
7.  左侧菜单选择 **"版本管理与发布"**。
    *   点击 **"创建版本"**。
    *   在 **"可用范围"** 中选择 **"所有员工"**。
    *   点击 **"保存并发布"**。

---

## 第二步：部署 Cloudflare Worker

1.  登录 Cloudflare Dashboard，进入 **"Workers & Pages"**。
2.  点击 **"Create Application"** -> **"Create Worker"**。
3.  给 Worker 起个名字（例如 `feishu-oauth-relay`），点击 **"Deploy"**。
4.  部署成功后，点击 **"Edit code"**。
5.  将以下代码完整复制粘贴到编辑器中（覆盖原有代码）：

```javascript
/**
 * Cloudflare Worker for Feishu OAuth Relay
 * 
 * Environment Variables required:
 * - APP_ID
 * - APP_SECRET
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Redirect to Feishu Login
    if (pathname === '/login') {
      const redirectUri = `${url.origin}/callback`;
      // Request permissions for Drive and Docx
      const scope = 'drive:drive docx:document:user_group_read_write';
      const feishuAuthUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${env.APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
      return Response.redirect(feishuAuthUrl, 302);
    }

    // 2. Callback: Exchange Code for Token
    if (pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });

      try {
        // Step A: Get App Access Token (Internal)
        const appTokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: env.APP_ID, app_secret: env.APP_SECRET })
        });
        const appTokenData = await appTokenRes.json();
        if (appTokenData.code !== 0) throw new Error('Failed to get app token: ' + appTokenData.msg);
        const appAccessToken = appTokenData.app_access_token;

        // Step B: Get User Access Token
        const userTokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appAccessToken}`
          },
          body: JSON.stringify({ 
            grant_type: 'authorization_code', 
            code: code 
          })
        });
        
        const userTokenData = await userTokenRes.json();
        if (userTokenData.code && userTokenData.code !== 0) throw new Error(userTokenData.msg || 'Auth Failed');

        // Display Token to User (JSON)
        return new Response(JSON.stringify(userTokenData.data, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (e) {
        return new Response('Error: ' + e.message, { status: 500 });
      }
    }

    // 3. Refresh Token
    if (pathname === '/refresh') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      const { refresh_token } = await request.json();
      
      if (!refresh_token) return new Response('Missing refresh_token', { status: 400 });

      try {
        // Step A: Get App Access Token
        const appTokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: env.APP_ID, app_secret: env.APP_SECRET })
        });
        const appTokenData = await appTokenRes.json();
        const appAccessToken = appTokenData.app_access_token;

        // Step B: Refresh User Token
        const refreshRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appAccessToken}`
          },
          body: JSON.stringify({ 
            grant_type: 'refresh_token', 
            refresh_token: refresh_token 
          })
        });

        const refreshData = await refreshRes.json();
        
        // Add CORS headers so plugin can call this
        return new Response(JSON.stringify(refreshData.data), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST'
          }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' } 
        });
      }
    }
    
    // Handle OPTIONS for CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    return new Response('Feishu OAuth Relay Worker is Running!');
  }
};
```

6.  点击右上角的 **"Save and deploy"**。

---

## 第三步：配置环境变量

1.  在 Worker 编辑页面，点击左上角的 Worker 名字返回 Worker 详情页。
2.  点击 **"Settings"** 标签页。
3.  点击 **"Variables"**。
4.  在 **"Environment Variables"** 部分，点击 **"Add variable"**，添加以下两个变量：
    *   `APP_ID`: (填入你在第一步获取的飞书 App ID)
    *   `APP_SECRET`: (填入你在第一步获取的飞书 App Secret)
5.  点击 **"Save and deploy"**。

---

## 第四步：完成飞书配置

1.  回到 Worker 详情页，找到你的 Worker URL（例如 `https://feishu-oauth-relay.yourname.workers.dev`）。
2.  回到 [飞书开放平台](https://open.feishu.cn/app) 的应用配置页面。
3.  进入 **"安全设置"** -> **"重定向 URL"**。
4.  点击 **"添加重定向 URL"**，填入 `<Worker URL>/callback`。
    *   例如：`https://feishu-oauth-relay.yourname.workers.dev/callback`
5.  点击 **"保存"**。

---

## 第五步：在 Web Clipper 插件中使用

1.  打开 Web Clipper 插件设置页。
2.  选择 **"账户"** -> **"添加账户"** -> 选择 **"飞书"**。
3.  在 **"Worker URL"** 中填入你的 Worker 链接（例如 `https://feishu-oauth-relay.yourname.workers.dev`）。
4.  点击 **"登录飞书"** 按钮。
5.  在弹出的窗口中完成飞书授权。
6.  授权成功后，页面会显示一段 JSON 代码（包含 `access_token` 等信息）。
7.  **复制整段 JSON 代码**。
8.  回到插件设置页，将 JSON 粘贴到 **"Token JSON"** 输入框中。
9.  点击保存，完成配置！

现在，插件将自动使用这个 Token 访问你的飞书空间，并在 Token 过期时自动通过 Worker 进行刷新。

