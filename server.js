import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { apiRouter } from './routes.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Body parsing with support for image uploads / base64 payloads
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// OAuth callback handler for popup authentication (transfers tokens via postMessage)
app.get(['/auth/callback', '/auth/callback/'], (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>กำลังยืนยันตัวตน...</title>
      </head>
      <body>
        <script>
          const hash = window.location.hash || '';
          const search = window.location.search || '';
          if (window.opener) {
            window.opener.postMessage({
              type: 'SUPABASE_OAUTH_CALLBACK',
              hash: hash,
              search: search
            }, '*');
            setTimeout(() => {
              window.close();
            }, 300);
          } else {
            window.location.href = '/' + hash;
          }
        </script>
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; color: #1e293b; text-align: center; padding: 24px;">
          <h3 style="font-size: 18px; font-weight: 700; margin: 0 0 8px 0;">เข้าสู่ระบบสำเร็จ</h3>
          <p style="font-size: 14px; color: #64748b; margin: 0;">กำลังปิดหน้าต่างนี้และกลับสู่ระบบ...</p>
        </div>
      </body>
    </html>
  `);
});

// Mount API routes
app.use('/api', apiRouter);

// Serve static assets
const distPath = path.join(__dirname, 'dist');
app.use(express.static(__dirname));
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Fallback to index.html for SPA routing
app.use((req, res) => {
  const rootIndex = path.join(__dirname, 'index.html');
  const distIndex = path.join(distPath, 'index.html');
  const indexPath = fs.existsSync(rootIndex) ? rootIndex : distIndex;
  res.sendFile(indexPath);
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});

export default app;
