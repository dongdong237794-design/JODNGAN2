# สรุปสิ่งที่แก้ไข + วิธีตั้งค่าให้ Google Login และ Google Calendar ใช้งานได้จริง

## บั๊กที่พบและแก้ไขแล้ว (โค้ด)

1. **ช่องโหว่ร้ายแรง: ปลอมตัวเป็นใครก็ได้ด้วยการพิมพ์อีเมล**
   ระบบเดิมมีปุ่ม/ฟอร์มให้ "พิมพ์อีเมล Google" แล้วเข้าสู่ระบบได้ทันที โดย backend
   (`/api/auth/google-login`) เชื่ออีเมลที่ส่งมาแบบไม่มีการตรวจสอบใดๆ เลย
   ทำให้ใครก็สามารถพิมพ์อีเมลของคนอื่นแล้วเข้าถึงข้อมูลของบัญชีนั้นได้ทันที
   → **ลบฟอร์ม/ปุ่มเหล่านี้ออกทั้งหมด** และแก้ backend ให้ต้องได้รับ Google ID Token
   จริง แล้วตรวจสอบกับ Google (`oauth2.googleapis.com/tokeninfo`) ก่อนออก session ทุกครั้ง

2. **บั๊ก ReferenceError ที่ทำให้หน้า Login พังเงียบๆ**
   ฟังก์ชัน `escapeHtml` และ `escapeAttr` ถูกเรียกใช้หลายจุด (รวมถึงตอนแสดงรายชื่อ
   "บัญชีที่เคยใช้งาน" บนหน้า Login) แต่ไม่เคยถูกประกาศไว้ในไฟล์เลย ทำให้เกิด
   `ReferenceError` และ JavaScript หยุดทำงานกลางคัน ซึ่งอาจเป็นสาเหตุหลักที่กดปุ่ม
   "เข้าสู่ระบบด้วย Google" แล้วไม่มีอะไรเกิดขึ้น → เพิ่มฟังก์ชันทั้งสองเข้าไปแล้ว

3. **ปุ่ม "โหมดทดลอง (Guest Demo)"** เดิมก็วิ่งผ่าน endpoint ที่ไม่ปลอดภัยเดียวกัน
   → แยกไปใช้ endpoint ใหม่ `/api/auth/guest-login` ที่ล็อกอินเข้าบัญชีทดลองคงที่
   บัญชีเดียวเท่านั้น ไม่สามารถใช้สวมรอยเป็นบัญชีจริงได้

4. **หน้า Login ถูกทำให้เรียบง่ายและเป็นสากลขึ้น**: เหลือแค่ปุ่ม "Sign in with Google"
   ที่แท้จริงหนึ่งปุ่ม + รายชื่อบัญชีที่เคยใช้ (กดแล้ววิ่งเข้ากระบวนการ Google จริง
   พร้อม pre-select บัญชี ไม่ใช่ bypass) + ปุ่มโหมดทดลอง ตัดตัวเลือก "พิมพ์อีเมล"
   ทุกรูปแบบออก

## สิ่งที่โค้ดแก้ให้ไม่ได้ — ต้องตั้งค่าฝั่ง Console เอง

โค้ดที่แก้ไปทั้งหมดจะยัง "เข้า Google ไม่ได้" ถ้ายังไม่ได้ตั้งค่าฝั่งนี้ให้ครบ เพราะ
Google Sign-In และ Google Calendar ต้องมีการลงทะเบียนแอปกับ Google และ Supabase จริง:

### 1) ตั้งค่า Google Sign-In (เส้นทางหลักของหน้า Login)
ระบบใช้ Google Identity Services (GIS) โดยตรงเพื่อรับ Google ID token แล้วส่งให้ backend ตรวจสอบกับ Google ก่อนออก session ดังนั้นหน้าเว็บไม่ต้อง redirect ไปยังหน้า OAuth callback ของ Supabase สำหรับการ Login
1. ไปที่ Supabase Dashboard → โปรเจกต์ของคุณ → **Authentication → Providers → Google**
2. เปิดใช้งาน Google Provider แล้วกรอก **Client ID** และ **Client Secret** ที่ได้จาก
   Google Cloud Console (ดูข้อ 3 ด้านล่าง)
3. ไปที่ **Authentication → URL Configuration** แล้วเพิ่ม Redirect URL ของเว็บคุณ เช่น
   `https://your-domain.com/auth/callback` (และ `http://localhost:3000/auth/callback`
   ถ้าจะทดสอบในเครื่อง)
4. ตั้งค่า Environment Variables ของโปรเจกต์ (ไฟล์ `.env` หรือใน Vercel):
   ```
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=xxxxx
   SUPABASE_SERVICE_ROLE_KEY=xxxxx
   ```

### 2) ตั้งค่า Google Calendar Sync
Google Calendar sync และปุ่ม "Sign in with Google" แบบ One-Tap ใช้ Google Client ID
แยกต่างหาก (ต้องเป็น OAuth Client ที่มี Authorized JavaScript origin ตรงกับโดเมนจริง):

1. ไปที่ [Google Cloud Console](https://console.cloud.google.com/) → เลือกหรือสร้างโปรเจกต์
2. เปิดใช้งาน **Google Calendar API** ที่ APIs & Services → Library
3. ไปที่ **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins: ใส่โดเมนจริงของเว็บ เช่น `https://your-domain.com`
     (และ `http://localhost:3000` สำหรับทดสอบ)
   - Authorized redirect URIs: ใส่ `https://<your-supabase-project>.supabase.co/auth/v1/callback`
     (อันนี้ Supabase จะบอกค่านี้ในหน้า Google provider settings)
4. คัดลอก **Client ID** ที่ได้ แล้ว:
   - ใส่เป็น Client ID/Secret ใน Supabase Google Provider (ข้อ 1)
   - ใส่ค่า Client ID เดียวกันในตัวแปรแวดล้อมของแอปนี้ด้วย:
     ```
     GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
     ```
5. ถ้าแอปยังอยู่ในสถานะ "Testing" บน OAuth consent screen ต้องเพิ่มอีเมลผู้ทดสอบ
   ใน **Test users** ก่อน ไม่งั้น Google จะปฏิเสธการล็อกอิน/ขอสิทธิ์ Calendar


> **สำคัญสำหรับภาพ Error 403 จาก `aistudio.google.com`**
>
> Google Sign-In ต้องทำงานจาก **โดเมนของเว็บที่คุณควบคุมและลงทะเบียนไว้ใน Google Cloud OAuth Client** เช่น `https://your-domain.com` ไม่ควรใช้ URL ของ AI Studio preview เป็น production origin เพราะ preview อาจถูกฝังใน iframe หรือถูกแพลตฟอร์มปฏิเสธด้วย 403 ได้ โค้ดเวอร์ชันนี้ใช้ GIS แบบไม่ redirect ทั้งหน้าเพื่อลดปัญหานี้ แต่การใช้งานจริงยังต้อง deploy ไปยังโดเมนที่ลงทะเบียนไว้กับ Google OAuth

### 3) ทดสอบ
- รีสตาร์ทเซิร์ฟเวอร์หลังตั้งค่า env แล้ว
- กด "เข้าสู่ระบบด้วย Google" ควรเด้งไปหน้าเลือกบัญชี Google จริง แล้วพากลับมาเข้าระบบ
- กด "เชื่อมต่อ Google Calendar" ควรขอสิทธิ์ calendar.events แล้วซิงค์งานอัตโนมัติ

หากยังมี error หลังตั้งค่าครบ ให้ดู error message ที่ระบบแสดง (จะบอกสาเหตุตรงๆ
เช่น popup ถูกบล็อก หรือยังไม่ได้ตั้งค่า provider) และดู Console log ของเบราว์เซอร์/เซิร์ฟเวอร์ประกอบ
