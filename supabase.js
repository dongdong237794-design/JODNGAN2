import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config({ override: true });

const DATA_DIR = path.join(process.cwd(), 'data');
const LOCAL_STORE_FILE = path.join(DATA_DIR, 'local_store.json');
const CONFIG_FILE = path.join(DATA_DIR, 'supabase_config.json');

let supabaseClient = null;
const userEmailToIdCache = new Map();

// Supabase reachability tracking
let isSupabaseOnline = false;
let hasCheckedHealth = false;
let lastHealthCheck = 0;
let lastHealthCheckError = null;
const HEALTH_CHECK_COOLDOWN = 60000; // 60s cooldown before retesting if offline
let healthCheckPromise = null;

// Load persisted Supabase credentials from data/supabase_config.json if available
export function loadSavedSupabaseConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg && typeof cfg === 'object') {
        if (typeof cfg.supabaseUrl === 'string') {
          process.env.SUPABASE_URL = cfg.supabaseUrl;
        }
        if (typeof cfg.supabaseAnonKey === 'string') {
          process.env.SUPABASE_ANON_KEY = cfg.supabaseAnonKey;
        }
        if (typeof cfg.supabaseServiceRoleKey === 'string') {
          process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.supabaseServiceRoleKey;
        }
      }
    }
  } catch (e) {
    // Config read error ignored
  }
}
loadSavedSupabaseConfig();

export function isSupabaseConfigured() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  return Boolean(url && key && typeof url === 'string' && url.startsWith('http'));
}

export function getSupabaseDiagnosticInfo() {
  const url = process.env.SUPABASE_URL || '';
  const hasKey = Boolean(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const isDnsError = Boolean(
    lastHealthCheckError && (
      lastHealthCheckError.includes('ENOTFOUND') ||
      lastHealthCheckError.includes('getaddrinfo') ||
      lastHealthCheckError.includes('fetch failed')
    )
  );

  return {
    configured: isSupabaseConfigured(),
    connected: isSupabaseOnline,
    hasUrl: Boolean(url),
    maskedUrl: url ? url.replace(/^(https?:\/\/[^.]+).*/, '$1.supabase.co') : '',
    hasKey,
    isPausedOrUnreachable: Boolean(url && !isSupabaseOnline),
    isDnsError: Boolean(isDnsError),
    lastError: lastHealthCheckError,
    mode: isSupabaseOnline ? 'supabase' : 'local_storage'
  };
}

export async function testSupabaseCredentials(url, key) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return { ok: false, error: 'URL ต้องขึ้นต้นด้วย https://' };
  }
  const cleanUrl = url.trim().replace(/\/$/, '');
  const cleanKey = (key || '').trim();

  try {
    const res = await fetch(`${cleanUrl}/rest/v1/`, {
      method: 'GET',
      headers: {
        apikey: cleanKey,
        ...(cleanKey ? { Authorization: `Bearer ${cleanKey}` } : {})
      },
      signal: AbortSignal.timeout(4000)
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: 'เชื่อมต่อไปยังโฮสต์สำเร็จ แต่ API Key ไม่ถูกต้อง (HTTP ' + res.status + ')'
      };
    }

    return {
      ok: true,
      message: 'เชื่อมต่อไปยังโฮสต์ Supabase สำเร็จ'
    };
  } catch (err) {
    const causeCode = err?.cause?.code || err?.code || '';
    const errMsg = `${err?.message || ''} ${causeCode}`.trim();
    if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo') || causeCode === 'ENOTFOUND') {
      return {
        ok: false,
        error: 'ไม่พบชื่อโฮสต์ (ENOTFOUND) โปรเจกต์อาจถูก Pause บน Supabase หรือกรอก URL ไม่ถูกต้อง'
      };
    }
    if (err?.name === 'TimeoutError' || errMsg.includes('timeout')) {
      return {
        ok: false,
        error: 'หมดเวลาการเชื่อมต่อ (Timeout) เซิร์ฟเวอร์ไม่ตอบสนอง'
      };
    }
    return {
      ok: false,
      error: 'ไม่สามารถเชื่อมต่อได้: ' + errMsg
    };
  }
}

export async function updateSupabaseConfig({ supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey }) {
  const cleanUrl = (supabaseUrl || '').trim();
  const cleanAnon = (supabaseAnonKey || '').trim();
  const cleanService = (supabaseServiceRoleKey || '').trim();

  if (cleanUrl) {
    const test = await testSupabaseCredentials(cleanUrl, cleanAnon || cleanService);
    if (!test.ok) {
      return {
        success: false,
        connected: false,
        message: test.error
      };
    }
  }

  // Update running environment
  process.env.SUPABASE_URL = cleanUrl;
  process.env.SUPABASE_ANON_KEY = cleanAnon;
  if (cleanService) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = cleanService;
  }

  // Reset internal client cache and status
  supabaseClient = null;
  hasCheckedHealth = false;
  isSupabaseOnline = false;
  lastHealthCheck = 0;
  lastHealthCheckError = null;
  userEmailToIdCache.clear();

  // Save to config file
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      supabaseUrl: cleanUrl,
      supabaseAnonKey: cleanAnon,
      supabaseServiceRoleKey: cleanService || '',
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {
    // ignore
  }

  if (cleanUrl && (cleanAnon || cleanService)) {
    const isHealthy = await checkSupabaseHealth(true);
    return {
      success: true,
      connected: isHealthy,
      message: isHealthy
        ? 'เชื่อมต่อกับ Supabase สำเร็จแล้ว ระบบพร้อมใช้งาน'
        : 'บันทึกการตั้งค่าแล้ว แต่ยังไม่สามารถอ่านตารางได้ กรุณาตรวจสอบว่าสร้างตารางด้วย supabase_schema.sql แล้ว'
    };
  }

  return {
    success: true,
    connected: false,
    message: 'สลับมาใช้โหมดจัดเก็บข้อมูลในเครื่อง (Local Storage) เรียบร้อยแล้ว'
  };
}

export async function clearCustomSupabaseConfig() {
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_ANON_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';

  supabaseClient = null;
  hasCheckedHealth = true;
  isSupabaseOnline = false;
  lastHealthCheck = Date.now();
  lastHealthCheckError = null;
  userEmailToIdCache.clear();

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
  } catch (e) {}

  return {
    success: true,
    connected: false,
    message: 'ลบการตั้งค่าเรียบร้อยแล้ว ระบบกำลังทำงานด้วยโหมดจัดเก็บในเครื่อง'
  };
}

export async function checkSupabaseHealth(force = false) {
  if (!isSupabaseConfigured()) {
    isSupabaseOnline = false;
    hasCheckedHealth = true;
    lastHealthCheckError = 'not_configured';
    return false;
  }

  const now = Date.now();
  if (!force && hasCheckedHealth && (now - lastHealthCheck < HEALTH_CHECK_COOLDOWN)) {
    return isSupabaseOnline;
  }

  if (healthCheckPromise) {
    return healthCheckPromise;
  }

  healthCheckPromise = (async () => {
    const url = process.env.SUPABASE_URL;
    try {
      // Test host DNS resolution and reachability with 2500ms timeout
      await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
        method: 'GET',
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
        },
        signal: AbortSignal.timeout(2500)
      });
      isSupabaseOnline = true;
      hasCheckedHealth = true;
      lastHealthCheck = Date.now();
      lastHealthCheckError = null;
      return true;
    } catch (err) {
      isSupabaseOnline = false;
      hasCheckedHealth = true;
      lastHealthCheck = Date.now();
      const causeCode = err?.cause?.code || err?.code || '';
      lastHealthCheckError = `${err?.message || 'connection failed'}${causeCode ? ' (' + causeCode + ')' : ''}`;
      return false;
    } finally {
      healthCheckPromise = null;
    }
  })();

  return healthCheckPromise;
}

export function isSupabaseAvailable() {
  if (!isSupabaseConfigured()) return false;
  if (!hasCheckedHealth) {
    checkSupabaseHealth();
    return false;
  }
  if (!isSupabaseOnline) {
    if (Date.now() - lastHealthCheck > HEALTH_CHECK_COOLDOWN) {
      checkSupabaseHealth();
    }
    return false;
  }
  return true;
}

export function markSupabaseFailed(err) {
  if (isSupabaseOnline) {
    isSupabaseOnline = false;
    lastHealthCheck = Date.now();
    lastHealthCheckError = err?.message || 'network error';
  }
}

export async function resolveRealSupabaseUserId(supabase, email, metadata = {}) {
  if (!supabase || !email || !isSupabaseAvailable()) return null;
  const cleanEmail = email.toLowerCase().trim();
  if (userEmailToIdCache.has(cleanEmail)) {
    return userEmailToIdCache.get(cleanEmail);
  }

  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (!error && data?.users) {
      const match = data.users.find(u => (u.email || '').toLowerCase().trim() === cleanEmail);
      if (match) {
        userEmailToIdCache.set(cleanEmail, match.id);
        return match.id;
      }
    }

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      email_confirm: true,
      user_metadata: metadata
    });
    if (!createErr && created?.user) {
      userEmailToIdCache.set(cleanEmail, created.user.id);
      return created.user.id;
    }
    if (createErr) {
      if (createErr.message && (createErr.message.includes('fetch failed') || createErr.message.includes('network'))) {
        markSupabaseFailed(createErr);
      } else {
        console.warn('Could not create user in Supabase auth:', createErr.message);
      }
    }
  } catch (err) {
    if (err.message && (err.message.includes('fetch failed') || err.message.includes('network'))) {
      markSupabaseFailed(err);
    } else {
      console.warn('resolveRealSupabaseUserId error:', err.message);
    }
  }

  return null;
}

export function emailToUuid(email) {
  const cleanEmail = (email || 'student@jodngan.local').toLowerCase().trim();
  const hash = crypto.createHash('sha256').update('google:' + cleanEmail).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    'a' + hash.substring(17, 20),
    hash.substring(20, 32)
  ].join('-');
}

export function createSessionToken(userPayload) {
  const raw = JSON.stringify({
    id: userPayload.id,
    email: userPayload.email,
    name: userPayload.name,
    picture: userPayload.picture,
    iat: Date.now()
  });
  return 'jodngan_' + Buffer.from(raw).toString('base64url');
}

export function getSupabase() {
  if (!isSupabaseAvailable()) {
    return null;
  }
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (url && key && url.startsWith('http')) {
    try {
      supabaseClient = createClient(url, key, {
        auth: { persistSession: false }
      });
    } catch (err) {
      console.error('Failed to initialize Supabase client:', err.message);
      supabaseClient = null;
    }
  }
  return supabaseClient;
}

export function getScopedSupabase(accessToken) {
  if (!isSupabaseAvailable()) {
    return null;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && key && url.startsWith('http')) {
    const isSupabaseJwt = accessToken && typeof accessToken === 'string' && accessToken.split('.').length === 3;
    if (isSupabaseJwt) {
      return createClient(url, key, {
        auth: { persistSession: false },
        global: {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      });
    }
  }
  return getSupabase();
}

export async function verifyUserToken(token) {
  if (!token) return null;

  // 1. Check with Supabase Auth first if token is a standard 3-part JWT
  const isSupabaseJwt = typeof token === 'string' && token.split('.').length === 3;
  if (isSupabaseJwt && isSupabaseAvailable()) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (!error && user) {
          return user;
        }
      } catch (err) {
        if (err.message && (err.message.includes('fetch failed') || err.message.includes('network'))) {
          markSupabaseFailed(err);
        } else {
          console.error('Supabase getUser error:', err.message);
        }
      }
    }
  }

  // 2. Fallback check for custom session token issued by our system (e.g. guest demo auth or google login)
  if (typeof token === 'string' && token.startsWith('jodngan_')) {
    try {
      const raw = Buffer.from(token.slice(8), 'base64url').toString('utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.email) {
        const realUserId = parsed.id || emailToUuid(parsed.email);
        return {
          id: realUserId,
          email: parsed.email,
          user_metadata: {
            full_name: parsed.name || parsed.email.split('@')[0],
            name: parsed.name || parsed.email.split('@')[0],
            avatar_url: parsed.picture || '',
            picture: parsed.picture || ''
          }
        };
      }
    } catch (err) {
      console.warn('Failed to parse custom session token:', err.message);
    }
  }

  return null;
}

// Fallback in-memory and file-backed storage (clean empty state - users add own data)
export const fallbackStore = {
  subjects: [],
  assignments: [],
  trash: [],
  studySessions: [],
  schedule: {},
  settings: {
    urgentDays: 3,
    defaultStatus: 'ยังไม่ส่ง',
    showCalDone: false,
    autoDark: false
  }
};

// Data Mapper Helpers
export function mapTaskFromDb(row) {
  let dueTime = row.due_time || '';
  if (!dueTime && row.due_date) {
    try {
      const d = new Date(row.due_date);
      if (!isNaN(d.getTime())) {
        const hrs = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        if (hrs !== '00' || mins !== '00') {
          dueTime = `${hrs}:${mins}`;
        }
      }
    } catch (e) {}
  }
  if (!dueTime) dueTime = '23:59';

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description || '',
    subject: row.subject || '',
    category: row.category || '',
    orderDate: row.order_date || new Date().toISOString(),
    dueDate: row.due_date || new Date().toISOString(),
    dueTime: dueTime,
    calendarEventId: row.calendar_event_id || '',
    status: row.status || 'ยังไม่ส่ง',
    priority: row.priority || 'ทั่วไป',
    subjectColor: row.subject_color || '#3B82F6',
    imageBase64: row.image_base64 || '',
    fileName: row.file_name || '',
    fileMime: row.file_mime || '',
    _deletedAt: row.deleted_at
  };
}

export function mapTaskToDb(task, userId = null, extraColumns = {}) {
  // Ensure dueDate includes the exact hours and minutes
  let dueDateIso = new Date().toISOString();
  if (task.dueDate) {
    try {
      const dueTime = task.dueTime || '23:59';
      const [h, m] = dueTime.split(':').map(n => parseInt(n, 10) || 0);
      const d = new Date(task.dueDate);
      if (!isNaN(d.getTime())) {
        d.setHours(h, m, 0, 0);
        dueDateIso = d.toISOString();
      }
    } catch (e) {
      dueDateIso = new Date(task.dueDate).toISOString();
    }
  }

  const dbObj = {
    id: task.id,
    title: String(task.title || '').trim(),
    description: task.description || '',
    subject: task.subject || '',
    category: task.category || '',
    order_date: task.orderDate ? new Date(task.orderDate).toISOString() : new Date().toISOString(),
    due_date: dueDateIso,
    status: task.status || 'ยังไม่ส่ง',
    priority: task.priority || 'ทั่วไป',
    subject_color: task.subjectColor || '#3B82F6',
    image_base64: task.imageBase64 || '',
    file_name: task.fileName || '',
    file_mime: task.fileMime || '',
    updated_at: new Date().toISOString()
  };

  if (extraColumns.hasDueTime) {
    dbObj.due_time = task.dueTime || '23:59';
  }
  if (extraColumns.hasCalendarEventId) {
    dbObj.calendar_event_id = task.calendarEventId || null;
  }
  if (userId) {
    dbObj.user_id = userId;
  }
  return dbObj;
}

export function mapStudySessionFromDb(row, subjectsMap = {}) {
  if (!row) return null;
  const subName = (row.subject_id && subjectsMap[row.subject_id]) ? subjectsMap[row.subject_id] : (row.subject_name || 'ทั่วไป');
  return {
    id: row.id,
    userId: row.user_id,
    subjectId: row.subject_id,
    subjectName: subName,
    targetMinutes: Number(row.target_duration_minutes || 25),
    targetDurationMinutes: Number(row.target_duration_minutes || 25),
    actualDurationSeconds: Number(row.actual_duration_seconds || 0),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    completedAt: row.ended_at,
    status: row.status || 'completed',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapStudySessionToDb(session, userId) {
  return {
    id: session.id,
    user_id: userId,
    subject_id: session.subjectId || null,
    target_duration_minutes: Number(session.targetDurationMinutes || session.targetMinutes || 25),
    actual_duration_seconds: Number(session.actualDurationSeconds || 0),
    started_at: session.startedAt ? new Date(session.startedAt).toISOString() : new Date().toISOString(),
    ended_at: session.endedAt || session.completedAt ? new Date(session.endedAt || session.completedAt).toISOString() : new Date().toISOString(),
    status: session.status || 'completed',
    notes: session.notes ? String(session.notes).trim() : '',
    updated_at: new Date().toISOString()
  };
}

export async function seedUserDataIfNeeded(supabaseClient, userId) {
  if (!supabaseClient || !userId) return;

  try {
    // Seed default settings for this user if not already set
    await supabaseClient.from('settings').upsert({
      id: userId,
      user_id: userId,
      data: fallbackStore.settings
    });
  } catch (err) {
    console.warn('Auto-seed settings for user failed:', err.message);
  }
}

export function initFallbackStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(LOCAL_STORE_FILE)) {
      const content = fs.readFileSync(LOCAL_STORE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed) {
        if (Array.isArray(parsed.assignments)) fallbackStore.assignments = parsed.assignments;
        if (Array.isArray(parsed.subjects) && parsed.subjects.length > 0) fallbackStore.subjects = parsed.subjects;
        if (Array.isArray(parsed.trash)) fallbackStore.trash = parsed.trash;
        if (Array.isArray(parsed.studySessions)) fallbackStore.studySessions = parsed.studySessions;
        if (parsed.schedule && typeof parsed.schedule === 'object') {
          fallbackStore.schedule = { ...fallbackStore.schedule, ...parsed.schedule };
        }
        if (parsed.settings && typeof parsed.settings === 'object') {
          fallbackStore.settings = { ...fallbackStore.settings, ...parsed.settings };
        }
      }
    } else {
      // Create initial local_store.json file
      const initialData = {
        assignments: fallbackStore.assignments,
        subjects: fallbackStore.subjects,
        trash: fallbackStore.trash,
        studySessions: fallbackStore.studySessions,
        schedule: fallbackStore.schedule,
        settings: fallbackStore.settings,
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(initialData, null, 2), 'utf8');
    }
  } catch (err) {
    console.warn('[Storage] Could not load local_store.json:', err.message);
  }
}

let saveTimeout = null;
export function saveFallbackStore() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const dataToSave = {
        assignments: fallbackStore.assignments,
        subjects: fallbackStore.subjects,
        trash: fallbackStore.trash,
        studySessions: fallbackStore.studySessions,
        schedule: fallbackStore.schedule,
        settings: fallbackStore.settings,
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Storage] Failed to write local_store.json:', err.message);
    }
  }, 50);
}

// Initialize fallback store from disk on module startup
initFallbackStore();

