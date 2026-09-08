import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  getSupabase,
  getScopedSupabase,
  verifyUserToken,
  isSupabaseConfigured,
  fallbackStore,
  seedUserDataIfNeeded,
  mapTaskFromDb,
  mapTaskToDb,
  mapStudySessionFromDb,
  mapStudySessionToDb,
  emailToUuid,
  createSessionToken
} from './supabase.js';

export const apiRouter = express.Router();

// Helper to detect whether Supabase database currently has user_id columns
let _hasUserIdCache = null;
async function dbSupportsUserId(supabase) {
  if (!supabase) return false;
  if (_hasUserIdCache !== null) return _hasUserIdCache;
  try {
    const { error } = await supabase.from('tasks').select('user_id').limit(1);
    _hasUserIdCache = !error;
  } catch (err) {
    _hasUserIdCache = false;
  }
  return _hasUserIdCache;
}

let _hasStudySessionsCache = null;
async function dbSupportsStudySessions(supabase) {
  if (!supabase) return false;
  if (_hasStudySessionsCache !== null) return _hasStudySessionsCache;
  try {
    const { error } = await supabase.from('study_sessions').select('id').limit(1);
    _hasStudySessionsCache = !error;
  } catch (err) {
    _hasStudySessionsCache = false;
  }
  return _hasStudySessionsCache;
}

let _hasDueTimeCache = null;
async function dbSupportsDueTime(supabase) {
  if (!supabase) return false;
  if (_hasDueTimeCache !== null) return _hasDueTimeCache;
  try {
    const { error } = await supabase.from('tasks').select('due_time').limit(1);
    _hasDueTimeCache = !error;
  } catch (err) {
    _hasDueTimeCache = false;
  }
  return _hasDueTimeCache;
}

let _hasCalendarEventIdCache = null;
async function dbSupportsCalendarEventId(supabase) {
  if (!supabase) return false;
  if (_hasCalendarEventIdCache !== null) return _hasCalendarEventIdCache;
  try {
    const { error } = await supabase.from('tasks').select('calendar_event_id').limit(1);
    _hasCalendarEventIdCache = !error;
  } catch (err) {
    _hasCalendarEventIdCache = false;
  }
  return _hasCalendarEventIdCache;
}

// Helper to read Google OAuth client ID from firebase config or env
function getGoogleOAuthClientId() {
  if (process.env.GOOGLE_CLIENT_ID) return process.env.GOOGLE_CLIENT_ID;
  try {
    const configPath = path.resolve('firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return parsed.oAuthClientId || '';
    }
  } catch (err) {
    console.warn('Could not read firebase-applet-config.json:', err.message);
  }
  return '';
}

// Verify a Google ID token (JWT) with Google before trusting any identity claim.
// This is what makes "Sign in with Google" actually secure: without this check,
// anyone could POST an arbitrary email/name to the server and be logged in as
// that person. Never trust identity fields that were not cryptographically verified.
async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!resp.ok) return null;
    const payload = await resp.json();
    if (!payload || !payload.email) return null;

    // The token must have been issued for THIS app's Google OAuth client.
    const expectedAud = getGoogleOAuthClientId();
    if (!expectedAud) {
      console.error('GOOGLE_CLIENT_ID is not configured; refusing Google login.');
      return null;
    }
    if (payload.aud !== expectedAud) {
      console.warn('Google ID token audience mismatch');
      return null;
    }

    if (payload.email_verified === false || payload.email_verified === 'false') {
      return null;
    }

    return payload;
  } catch (err) {
    console.error('Google ID token verification failed:', err.message);
    return null;
  }
}

// Verify a Google OAuth2 access token with Google to ensure it belongs to this client and extract profile info.
async function verifyGoogleAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return null;
  try {
    // 1. Verify token audience with Google's tokeninfo endpoint
    const tokenInfoResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!tokenInfoResp.ok) {
      console.warn('Google tokeninfo rejected access token');
      return null;
    }
    const tokenInfo = await tokenInfoResp.json();
    const expectedAud = getGoogleOAuthClientId();
    if (!expectedAud) {
      console.error('GOOGLE_CLIENT_ID is not configured; refusing Google login.');
      return null;
    }
    const tokenAud = tokenInfo.aud || tokenInfo.azp;
    if (tokenAud !== expectedAud) {
      console.warn('Google access token audience mismatch:', tokenAud, 'expected:', expectedAud);
      return null;
    }

    // 2. Fetch authenticated profile from Google userinfo
    const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!userInfoResp.ok) {
      console.warn('Google userinfo request failed');
      return null;
    }
    const userInfo = await userInfoResp.json();
    if (!userInfo || !userInfo.email) return null;
    if (userInfo.email_verified === false || userInfo.email_verified === 'false') {
      return null;
    }

    return {
      email: userInfo.email,
      name: userInfo.name || userInfo.given_name || userInfo.email.split('@')[0],
      picture: userInfo.picture
    };
  } catch (err) {
    console.error('Google access token verification error:', err.message);
    return null;
  }
}

// GET /api/auth-config - Expose public Supabase credentials and Google OAuth client ID
apiRouter.get('/auth-config', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    supabaseConfigured: isSupabaseConfigured(),
    googleConfigured: !!getGoogleOAuthClientId(),
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    googleClientId: getGoogleOAuthClientId(),
    calendarScope: 'https://www.googleapis.com/auth/calendar.events'
  });
});

// POST /api/auth/google-login - Verify a real Google credential (ID token or OAuth access token)
// and issue a session. The client must send a cryptographic token obtained from Google.
apiRouter.post('/auth/google-login', async (req, res) => {
  const { credential, accessToken, access_token } = req.body || {};
  const tokenToVerify = accessToken || access_token;

  if (!credential && !tokenToVerify) {
    return res.status(400).json({ error: 'Missing Google credential or access token' });
  }

  let payload = null;
  if (credential && typeof credential === 'string') {
    payload = await verifyGoogleIdToken(credential);
  } else if (tokenToVerify && typeof tokenToVerify === 'string') {
    payload = await verifyGoogleAccessToken(tokenToVerify);
  }

  if (!payload || !payload.email) {
    return res.status(401).json({
      error: 'ไม่สามารถยืนยันตัวตนกับ Google ได้ กรุณาลองเข้าสู่ระบบใหม่อีกครั้ง'
    });
  }

  const cleanEmail = payload.email.toLowerCase().trim();
  const userId = emailToUuid(cleanEmail);
  const fullName = payload.name && payload.name.trim() ? payload.name.trim() : cleanEmail.split('@')[0];
  const avatarUrl = payload.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=1E293B&color=fff&size=96`;

  const userPayload = {
    id: userId,
    email: cleanEmail,
    name: fullName,
    picture: avatarUrl
  };

  const token = createSessionToken(userPayload);

  // Record or update user profile in Supabase if table exists
  const supabase = getSupabase();
  if (supabase) {
    try {
      await supabase.from('profiles').upsert({
        id: userId,
        email: cleanEmail,
        full_name: fullName,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' }).catch(() => {});
    } catch(err) {
      // Ignore profile write if table not available
    }
  }

  return res.json({
    success: true,
    token,
    user: {
      id: userId,
      email: cleanEmail,
      user_metadata: {
        full_name: fullName,
        name: fullName,
        avatar_url: avatarUrl,
        picture: avatarUrl
      }
    }
  });
});

// POST /api/auth/guest-login - Explicit, clearly-labelled demo/guest sandbox.
// Always resolves to the SAME fixed demo account (no arbitrary email is ever
// accepted here), so this can never be used to impersonate a real user.
apiRouter.post('/auth/guest-login', async (req, res) => {
  const cleanEmail = 'student.demo@jodngan.local';
  const fullName = 'นักเรียนทดลอง';
  const userId = emailToUuid(cleanEmail);
  const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=10B981&color=fff&size=96`;

  const token = createSessionToken({ id: userId, email: cleanEmail, name: fullName, picture: avatarUrl });

  return res.json({
    success: true,
    token,
    user: {
      id: userId,
      email: cleanEmail,
      user_metadata: {
        full_name: fullName,
        name: fullName,
        avatar_url: avatarUrl,
        picture: avatarUrl,
        is_guest: true
      }
    }
  });
});

// Authentication & Authorization Middleware
export async function requireAuth(req, res, next) {
  const configured = isSupabaseConfigured();
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or empty Bearer token in Authorization header'
    });
  }

  const user = await verifyUserToken(token);
  if (!user) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired session token'
    });
  }

  req.user = user;
  req.token = token;
  req.supabase = getScopedSupabase(token);
  next();
}

// GET /api/status - Check Supabase connectivity
apiRouter.get('/status', async (req, res) => {
  const configured = isSupabaseConfigured();
  if (!configured) {
    return res.json({
      configured: false,
      connected: false,
      message: 'Supabase credentials not configured in environment variables. Running in local fallback mode.'
    });
  }

  const supabase = getSupabase();
  try {
    const { error } = await supabase.from('subjects').select('id', { head: true, count: 'exact' });
    if (error) {
      return res.json({
        configured: true,
        connected: false,
        message: `Connected to Supabase URL, but database error occurred: ${error.message}`
      });
    }
    return res.json({
      configured: true,
      connected: true,
      message: 'Connected to Supabase PostgreSQL database successfully.'
    });
  } catch (err) {
    return res.json({
      configured: true,
      connected: false,
      message: `Connection test failed: ${err.message}`
    });
  }
});

// GET /api/me - Fetch current authenticated user profile
apiRouter.get('/me', requireAuth, async (req, res) => {
  const user = req.user;
  const supabase = req.supabase || getSupabase();
  let profile = null;

  if (supabase && user.id !== '00000000-0000-0000-0000-000000000000') {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();
      profile = data;
    } catch (err) {
      console.warn('Profile fetch warning:', err.message);
    }
  }

  return res.json({
    id: user.id,
    email: user.email,
    fullName: profile?.full_name || user.user_metadata?.full_name || user.user_metadata?.name || user.email || 'ผู้ใช้งาน',
    avatarUrl: profile?.avatar_url || user.user_metadata?.avatar_url || user.user_metadata?.picture || '',
    metadata: user.user_metadata
  });
});

// GET /api/data - Fetch user-isolated dataset (assignments, subjects, schedule, trash, settings)
apiRouter.get('/data', requireAuth, async (req, res) => {
  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (!supabase) {
    return res.json({
      source: 'local_fallback',
      assignments: fallbackStore.assignments,
      subjects: fallbackStore.subjects,
      schedule: fallbackStore.schedule,
      trash: fallbackStore.trash,
      settings: fallbackStore.settings,
      studySessions: (fallbackStore.studySessions || []).filter(s => !s.userId || s.userId === userId)
    });
  }

  try {
    const hasUserId = await dbSupportsUserId(supabase);

    if (hasUserId) {
      await seedUserDataIfNeeded(supabase, userId);
    }

    // 1. Fetch Subjects
    let subQuery = supabase.from('subjects').select('*').order('created_at', { ascending: true });
    if (hasUserId) subQuery = subQuery.eq('user_id', userId);
    const { data: subData, error: subErr } = await subQuery;
    if (subErr) throw subErr;

    // 2. Fetch Active Tasks
    let taskQuery = supabase.from('tasks').select('*').eq('is_deleted', false).order('order_date', { ascending: false });
    if (hasUserId) taskQuery = taskQuery.eq('user_id', userId);
    const { data: taskData, error: taskErr } = await taskQuery;
    if (taskErr) throw taskErr;

    // 3. Fetch Trash Tasks
    let trashQuery = supabase.from('tasks').select('*').eq('is_deleted', true).order('deleted_at', { ascending: false });
    if (hasUserId) trashQuery = trashQuery.eq('user_id', userId);
    const { data: trashData, error: trashErr } = await trashQuery;
    if (trashErr) throw trashErr;

    // 4. Fetch Schedule
    let schedQuery = supabase.from('schedule').select('*');
    if (hasUserId) schedQuery = schedQuery.eq('user_id', userId);
    const { data: schedData, error: schedErr } = await schedQuery;
    if (schedErr) throw schedErr;

    const formattedSchedule = {};
    if (schedData && schedData.length > 0) {
      for (const row of schedData) {
        if (!formattedSchedule[row.day]) {
          formattedSchedule[row.day] = {};
        }
        formattedSchedule[row.day][row.period_time] = row.subject;
      }
    }

    // 5. Fetch Settings
    let setQuery = supabase.from('settings').select('data');
    if (hasUserId) {
      setQuery = setQuery.eq('user_id', userId);
    } else {
      setQuery = setQuery.eq('id', 'default');
    }
    const { data: setRow } = await setQuery.maybeSingle();

    // 6. Fetch Study Sessions (recent 50, ordered by started_at desc)
    let studySessions = [];
    const subjectsMap = Object.fromEntries((subData || []).map(s => [s.id, s.name]));
    const hasStudyTable = await dbSupportsStudySessions(supabase);
    if (hasStudyTable) {
      try {
        let studyQuery = supabase.from('study_sessions').select('*').order('started_at', { ascending: false }).limit(50);
        if (hasUserId) studyQuery = studyQuery.eq('user_id', userId);
        const { data: studyData, error: studyErr } = await studyQuery;
        if (!studyErr && studyData) {
          studySessions = studyData.map(s => mapStudySessionFromDb(s, subjectsMap));
        }
      } catch (err) {
        console.warn('Could not fetch study_sessions:', err.message);
      }
    } else {
      studySessions = (fallbackStore.studySessions || []).filter(s => !s.userId || s.userId === userId);
    }

    const assignments = (taskData || []).map(mapTaskFromDb);
    const trash = (trashData || []).map(mapTaskFromDb);
    const subjects = subData || [];
    const settings = setRow?.data || fallbackStore.settings;

    return res.json({
      source: 'supabase',
      userId,
      assignments,
      subjects,
      schedule: Object.keys(formattedSchedule).length > 0 ? formattedSchedule : fallbackStore.schedule,
      trash,
      settings,
      studySessions
    });
  } catch (err) {
    console.error('Error querying Supabase for user data:', err.message);
    return res.json({
      source: 'local_fallback',
      error: err.message,
      assignments: fallbackStore.assignments,
      subjects: fallbackStore.subjects,
      schedule: fallbackStore.schedule,
      trash: fallbackStore.trash,
      settings: fallbackStore.settings,
      studySessions: (fallbackStore.studySessions || []).filter(s => !s.userId || s.userId === userId)
    });
  }
});

// POST /api/tasks - Create or update task for current user
apiRouter.post('/tasks', requireAuth, async (req, res) => {
  const task = req.body;
  if (!task || !task.id || !task.title || !String(task.title).trim()) {
    return res.status(400).json({ error: 'Task ID and a valid title are required' });
  }

  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      
      // Strict ownership check if updating existing task
      if (hasUserId) {
        const { data: existing } = await supabase
          .from('tasks')
          .select('user_id')
          .eq('id', task.id)
          .maybeSingle();

        if (existing && existing.user_id && existing.user_id !== userId) {
          return res.status(403).json({ error: 'Unauthorized: You do not have permission to modify this task' });
        }
      }

      const hasDueTime = await dbSupportsDueTime(supabase);
      const hasCalendarEventId = await dbSupportsCalendarEventId(supabase);

      const dbTask = mapTaskToDb(task, hasUserId ? userId : null, {
        hasDueTime,
        hasCalendarEventId
      });
      dbTask.is_deleted = false;
      dbTask.deleted_at = null;

      const { data, error } = await supabase
        .from('tasks')
        .upsert(dbTask, { onConflict: 'id' })
        .select()
        .single();

      if (error) throw error;
      return res.json({ success: true, task: mapTaskFromDb(data) });
    } catch (err) {
      console.error('Failed to save task to Supabase:', err.message);
      return res.status(500).json({ error: 'Database save failed', message: err.message });
    }
  }

  // Local fallback
  const idx = fallbackStore.assignments.findIndex(t => t.id === task.id);
  const normalizedTask = {
    ...task,
    title: String(task.title).trim(),
    dueTime: task.dueTime || '23:59'
  };
  if (idx !== -1) {
    fallbackStore.assignments[idx] = { ...fallbackStore.assignments[idx], ...normalizedTask };
  } else {
    fallbackStore.assignments.unshift(normalizedTask);
  }
  return res.json({ success: true, task: normalizedTask });
});

// DELETE /api/tasks/:id - Soft delete to trash (Owner verified)
apiRouter.delete('/tasks/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      let query = supabase
        .from('tasks')
        .update({
          is_deleted: true,
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (hasUserId) query = query.eq('user_id', userId);

      const { error } = await query;
      if (error) throw error;
      return res.json({ success: true, id });
    } catch (err) {
      console.error('Failed to soft delete task in Supabase:', err.message);
      return res.status(500).json({ error: 'Database delete failed', message: err.message });
    }
  }

  // Local fallback
  const task = fallbackStore.assignments.find(t => t.id === id);
  if (task) {
    fallbackStore.assignments = fallbackStore.assignments.filter(t => t.id !== id);
    fallbackStore.trash.unshift({ ...task, _deletedAt: new Date().toISOString() });
    if (fallbackStore.trash.length > 50) fallbackStore.trash.pop();
  }
  return res.json({ success: true, id });
});

// POST /api/tasks/:id/restore - Restore task from trash (Owner verified)
apiRouter.post('/tasks/:id/restore', requireAuth, async (req, res) => {
  const { id } = req.params;
  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      let query = supabase
        .from('tasks')
        .update({
          is_deleted: false,
          deleted_at: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (hasUserId) query = query.eq('user_id', userId);

      const { data, error } = await query.select().single();
      if (error) throw error;
      return res.json({ success: true, task: mapTaskFromDb(data) });
    } catch (err) {
      console.error('Failed to restore task in Supabase:', err.message);
      return res.status(500).json({ error: 'Database restore failed', message: err.message });
    }
  }

  // Local fallback
  const idx = fallbackStore.trash.findIndex(t => t.id === id);
  if (idx !== -1) {
    const [task] = fallbackStore.trash.splice(idx, 1);
    delete task._deletedAt;
    fallbackStore.assignments.push(task);
    return res.json({ success: true, task });
  }
  return res.json({ success: true, id });
});

// DELETE /api/tasks/:id/permanent - Permanently delete task (Owner verified)
apiRouter.delete('/tasks/:id/permanent', requireAuth, async (req, res) => {
  const { id } = req.params;
  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      let query = supabase.from('tasks').delete().eq('id', id);
      if (hasUserId) query = query.eq('user_id', userId);

      const { error } = await query;
      if (error) throw error;
      return res.json({ success: true, id });
    } catch (err) {
      console.error('Failed to permanently delete task in Supabase:', err.message);
      return res.status(500).json({ error: 'Database permanent delete failed', message: err.message });
    }
  }

  // Local fallback
  fallbackStore.trash = fallbackStore.trash.filter(t => t.id !== id);
  return res.json({ success: true, id });
});

// POST /api/tasks/clear-trash - Empty user trash
apiRouter.post('/tasks/clear-trash', requireAuth, async (req, res) => {
  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      let query = supabase.from('tasks').delete().eq('is_deleted', true);
      if (hasUserId) query = query.eq('user_id', userId);

      const { error } = await query;
      if (error) throw error;
      return res.json({ success: true });
    } catch (err) {
      console.error('Failed to clear trash in Supabase:', err.message);
      return res.status(500).json({ error: 'Clear trash failed', message: err.message });
    }
  }

  fallbackStore.trash = [];
  return res.json({ success: true });
});

// POST /api/subjects - Create or update subject for current user
apiRouter.post('/subjects', requireAuth, async (req, res) => {
  const subject = req.body;
  if (!subject || !subject.name) {
    return res.status(400).json({ error: 'Subject name is required' });
  }

  const userId = req.user.id;
  if (!subject.id) {
    subject.id = `SUB-${Date.now()}`;
  }

  const supabase = req.supabase || getSupabase();
  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      const subPayload = {
        id: subject.id,
        name: subject.name,
        category: subject.category || 'วิชาสามัญ',
        color: subject.color || '#3B82F6',
        updated_at: new Date().toISOString()
      };
      if (hasUserId) subPayload.user_id = userId;

      const { data, error } = await supabase
        .from('subjects')
        .upsert(subPayload, { onConflict: 'id' })
        .select()
        .single();

      if (error) throw error;
      return res.json({ success: true, subject: data });
    } catch (err) {
      console.error('Failed to save subject to Supabase:', err.message);
      return res.status(500).json({ error: 'Subject save failed', message: err.message });
    }
  }

  // Local fallback
  const idx = fallbackStore.subjects.findIndex(s => s.id === subject.id);
  if (idx !== -1) {
    fallbackStore.subjects[idx] = { ...fallbackStore.subjects[idx], ...subject };
  } else {
    fallbackStore.subjects.push(subject);
  }
  return res.json({ success: true, subject });
});

// DELETE /api/subjects/:id - Delete subject (Owner verified)
apiRouter.delete('/subjects/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      let query = supabase.from('subjects').delete().eq('id', id);
      if (hasUserId) query = query.eq('user_id', userId);

      const { error } = await query;
      if (error) throw error;
      return res.json({ success: true, id });
    } catch (err) {
      console.error('Failed to delete subject in Supabase:', err.message);
      return res.status(500).json({ error: 'Subject delete failed', message: err.message });
    }
  }

  fallbackStore.subjects = fallbackStore.subjects.filter(s => s.id !== id);
  return res.json({ success: true, id });
});

// POST /api/schedule - Update schedule cell for current user
apiRouter.post('/schedule', requireAuth, async (req, res) => {
  const { day, period, subject } = req.body;
  if (!day || !period) {
    return res.status(400).json({ error: 'Day and period are required' });
  }

  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      const schedPayload = {
        day,
        period_time: period,
        subject: subject || '',
        updated_at: new Date().toISOString()
      };
      if (hasUserId) {
        schedPayload.user_id = userId;
      }

      const { error } = await supabase
        .from('schedule')
        .upsert(schedPayload, { onConflict: hasUserId ? 'user_id,day,period_time' : 'day,period_time' });

      if (error) throw error;
      return res.json({ success: true, day, period, subject });
    } catch (err) {
      console.error('Failed to update schedule in Supabase:', err.message);
      return res.status(500).json({ error: 'Schedule update failed', message: err.message });
    }
  }

  // Local fallback
  if (!fallbackStore.schedule[day]) fallbackStore.schedule[day] = {};
  fallbackStore.schedule[day][period] = subject;
  return res.json({ success: true, day, period, subject });
});

// POST /api/settings - Update application settings for current user
apiRouter.post('/settings', requireAuth, async (req, res) => {
  const settingsData = req.body;
  const supabase = req.supabase || getSupabase();
  const userId = req.user.id;

  if (supabase) {
    try {
      const hasUserId = await dbSupportsUserId(supabase);
      const setPayload = {
        id: hasUserId ? userId : 'default',
        data: settingsData,
        updated_at: new Date().toISOString()
      };
      if (hasUserId) setPayload.user_id = userId;

      const { error } = await supabase
        .from('settings')
        .upsert(setPayload, { onConflict: 'id' });

      if (error) throw error;
      return res.json({ success: true, settings: settingsData });
    } catch (err) {
      console.error('Failed to update settings in Supabase:', err.message);
      return res.status(500).json({ error: 'Settings update failed', message: err.message });
    }
  }

  fallbackStore.settings = { ...fallbackStore.settings, ...settingsData };
  return res.json({ success: true, settings: fallbackStore.settings });
});

// POST /api/study-sessions - Save or update study session for current user
apiRouter.post('/study-sessions', requireAuth, async (req, res) => {
  const session = req.body;
  const userId = req.user.id;
  const supabase = req.supabase || getSupabase();

  if (!session || typeof session !== 'object') {
    return res.status(400).json({ error: 'ข้อมูลการเรียนไม่ถูกต้อง' });
  }

  const id = session.id ? String(session.id) : `SS-${Date.now()}`;
  let subjectId = session.subjectId ? String(session.subjectId) : null;
  let subjectName = session.subjectName || session.subject || 'ทั่วไป';

  if (subjectId && supabase) {
    try {
      const { data: matchedSub } = await supabase
        .from('subjects')
        .select('id, name')
        .eq('id', subjectId)
        .eq('user_id', userId)
        .maybeSingle();
      if (matchedSub) {
        subjectId = matchedSub.id;
        if (matchedSub.name) subjectName = matchedSub.name;
      } else {
        subjectId = null;
      }
    } catch(e) {
      console.warn('Subject verification check failed:', e.message);
    }
  } else if (!subjectId && subjectName && subjectName !== 'ทั่วไป' && supabase) {
    try {
      const { data: matchedSub } = await supabase
        .from('subjects')
        .select('id, name')
        .eq('name', subjectName)
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
      if (matchedSub && matchedSub.id) {
        subjectId = matchedSub.id;
        if (matchedSub.name) subjectName = matchedSub.name;
      }
    } catch(e) {}
  }

  const targetMins = Math.max(1, parseInt(session.targetDurationMinutes || session.targetMinutes, 10) || 25);
  const actualSecs = Math.max(0, parseInt(session.actualDurationSeconds, 10) || 0);
  const startedAt = session.startedAt ? new Date(session.startedAt).toISOString() : new Date().toISOString();
  const endedAt = session.endedAt || session.completedAt ? new Date(session.endedAt || session.completedAt).toISOString() : new Date().toISOString();

  const sessionData = {
    id,
    userId,
    subjectId,
    subjectName,
    targetMinutes: targetMins,
    targetDurationMinutes: targetMins,
    actualDurationSeconds: actualSecs,
    startedAt,
    endedAt,
    completedAt: endedAt,
    status: session.status || 'completed',
    notes: session.notes ? String(session.notes).trim() : ''
  };

  if (!supabase) {
    const existingIdx = fallbackStore.studySessions.findIndex(s => s.id === id);
    if (existingIdx !== -1) {
      fallbackStore.studySessions[existingIdx] = sessionData;
    } else {
      fallbackStore.studySessions.unshift(sessionData);
    }
    return res.json({ success: true, source: 'fallback', session: sessionData });
  }

  try {
    const hasStudyTable = await dbSupportsStudySessions(supabase);
    if (!hasStudyTable) {
      const existingIdx = fallbackStore.studySessions.findIndex(s => s.id === id);
      if (existingIdx !== -1) {
        fallbackStore.studySessions[existingIdx] = sessionData;
      } else {
        fallbackStore.studySessions.unshift(sessionData);
      }
      return res.json({ success: true, source: 'fallback', session: sessionData });
    }

    const dbPayload = mapStudySessionToDb(sessionData, userId);
    const { data, error } = await supabase
      .from('study_sessions')
      .upsert(dbPayload)
      .select('*')
      .single();

    if (error) throw error;
    const subjectsMap = {};
    if (subjectId) subjectsMap[subjectId] = subjectName;
    const saved = mapStudySessionFromDb(data, subjectsMap) || sessionData;
    if (!saved.subjectName && subjectName) saved.subjectName = subjectName;
    return res.json({ success: true, source: 'supabase', session: saved });
  } catch (err) {
    console.error('Error saving study session:', err.message);
    const existingIdx = fallbackStore.studySessions.findIndex(s => s.id === id);
    if (existingIdx !== -1) {
      fallbackStore.studySessions[existingIdx] = sessionData;
    } else {
      fallbackStore.studySessions.unshift(sessionData);
    }
    return res.json({ success: true, source: 'fallback_error', session: sessionData, warning: err.message });
  }
});

// DELETE /api/study-sessions/:id - Delete a study session
apiRouter.delete('/study-sessions/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const supabase = req.supabase || getSupabase();

  if (!supabase) {
    fallbackStore.studySessions = fallbackStore.studySessions.filter(s => s.id !== id);
    return res.json({ success: true, source: 'fallback' });
  }

  try {
    const hasStudyTable = await dbSupportsStudySessions(supabase);
    if (hasStudyTable) {
      const { error } = await supabase
        .from('study_sessions')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);

      if (error) throw error;
    }
    fallbackStore.studySessions = fallbackStore.studySessions.filter(s => s.id !== id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting study session:', err.message);
    return res.status(500).json({ error: 'ไม่สามารถลบประวัติการเรียนได้' });
  }
});
