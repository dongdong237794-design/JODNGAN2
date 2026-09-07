-- ==========================================================
-- JodNGan (จดงาน) Database Schema for Supabase PostgreSQL
-- ==========================================================

-- 1. Create profiles table (Phase 2: User Identity)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    full_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 2. Create subjects table
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL, -- 'วิชาสามัญ' หรือ 'วิชาศาสนา'
    color TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Create tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    subject TEXT,
    category TEXT,
    order_date TIMESTAMPTZ,
    due_date TIMESTAMPTZ,
    due_time TEXT DEFAULT '23:59',
    calendar_event_id TEXT,
    status TEXT NOT NULL DEFAULT 'ยังไม่ส่ง',
    priority TEXT NOT NULL DEFAULT 'ทั่วไป',
    subject_color TEXT,
    image_base64 TEXT,
    file_name TEXT,
    file_mime TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. Create schedule table
CREATE TABLE IF NOT EXISTS schedule (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    day TEXT NOT NULL, -- 'อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี'
    period_time TEXT NOT NULL, -- เช่น '07:50-08:30'
    subject TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 5. Create settings table
CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 6. Create study_sessions table (Phase 4: Study Timer)
CREATE TABLE IF NOT EXISTS study_sessions (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
    target_duration_minutes INTEGER NOT NULL DEFAULT 25,
    actual_duration_seconds INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed', -- 'completed', 'stopped_early'
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- ==========================================================
-- Migration script for existing databases (Phase 2 Additions)
-- ==========================================================
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time TEXT DEFAULT '23:59';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Adjust schedule unique constraint to be per-user
ALTER TABLE schedule DROP CONSTRAINT IF EXISTS unique_day_period;
ALTER TABLE schedule DROP CONSTRAINT IF EXISTS unique_user_day_period;
ALTER TABLE schedule ADD CONSTRAINT unique_user_day_period UNIQUE (user_id, day, period_time);

-- ==========================================================
-- Indexes for performance & multi-tenant isolation
-- ==========================================================
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_is_deleted ON tasks(is_deleted);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_subjects_user_id ON subjects(user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_user_id ON schedule(user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_day ON schedule(day);
CREATE INDEX IF NOT EXISTS idx_settings_user_id ON settings(user_id);
CREATE INDEX IF NOT EXISTS idx_study_sessions_user_id ON study_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_study_sessions_started_at ON study_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_sessions_subject_id ON study_sessions(subject_id);

-- ==========================================================
-- Row Level Security (RLS) Setup (Phase 2: Strict Isolation)
-- ==========================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;

-- Clean existing policies
DO $$
BEGIN
    DROP POLICY IF EXISTS "Public access profiles" ON profiles;
    DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

    DROP POLICY IF EXISTS "Public access subjects" ON subjects;
    DROP POLICY IF EXISTS "Users can manage own subjects" ON subjects;

    DROP POLICY IF EXISTS "Public access tasks" ON tasks;
    DROP POLICY IF EXISTS "Users can manage own tasks" ON tasks;

    DROP POLICY IF EXISTS "Public access schedule" ON schedule;
    DROP POLICY IF EXISTS "Users can manage own schedule" ON schedule;

    DROP POLICY IF EXISTS "Public access settings" ON settings;
    DROP POLICY IF EXISTS "Users can manage own settings" ON settings;

    DROP POLICY IF EXISTS "Public access study_sessions" ON study_sessions;
    DROP POLICY IF EXISTS "Users can manage own study sessions" ON study_sessions;
END $$;

-- 1. Profiles Policies
CREATE POLICY "Users can view own profile" ON profiles
    FOR SELECT TO authenticated
    USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
    FOR UPDATE TO authenticated
    USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON profiles
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = id);

-- 2. Tasks Policies (Strict User Ownership)
CREATE POLICY "Users can manage own tasks" ON tasks
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 3. Subjects Policies (Strict User Ownership)
CREATE POLICY "Users can manage own subjects" ON subjects
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 4. Schedule Policies (Strict User Ownership)
CREATE POLICY "Users can manage own schedule" ON schedule
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 5. Settings Policies (Strict User Ownership)
CREATE POLICY "Users can manage own settings" ON settings
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 6. Study Sessions Policies (Strict User Ownership)
CREATE POLICY "Users can manage own study sessions" ON study_sessions
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ==========================================================
-- Automatic User Provisioning Trigger (Google OAuth Sign-in)
-- ==========================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. Insert Profile
    INSERT INTO public.profiles (id, email, full_name, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NEW.email),
        COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture', '')
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = NOW();

    -- 2. Seed Default Subjects for the new user
    INSERT INTO public.subjects (id, user_id, name, category, color) VALUES
    ('SUB-R1-' || NEW.id, NEW.id, 'อัลกุอาน', 'วิชาศาสนา', '#10B981'),
    ('SUB-R2-' || NEW.id, NEW.id, 'อัลกุรอาน และตัฟซีร (แบบัยด์)', 'วิชาศาสนา', '#10B981'),
    ('SUB-R3-' || NEW.id, NEW.id, 'MELAYU', 'วิชาศาสนา', '#F59E0B'),
    ('SUB-R4-' || NEW.id, NEW.id, 'อัลอากีดะฮ์ (แบวัน)', 'วิชาศาสนา', '#8B5CF6'),
    ('SUB-R5-' || NEW.id, NEW.id, 'อัลหะดีษ', 'วิชาศาสนา', '#06B6D4'),
    ('SUB-R6-' || NEW.id, NEW.id, 'อัลอัคลาก', 'วิชาศาสนา', '#EC4899'),
    ('SUB-R7-' || NEW.id, NEW.id, 'ฮาลากอฮ์', 'วิชาศาสนา', '#14B8A6'),
    ('SUB-R8-' || NEW.id, NEW.id, 'อัตตารีค', 'วิชาศาสนา', '#F97316'),
    ('SUB-R9-' || NEW.id, NEW.id, 'ตัฟซีร', 'วิชาศาสนา', '#6366F1'),
    ('SUB-R10-' || NEW.id, NEW.id, 'อัลฟิกฮ์', 'วิชาศาสนา', '#84CC16'),
    ('SUB-G1-' || NEW.id, NEW.id, 'คณิตศาสตร์ (แบฟุรกอน)', 'วิชาสามัญ', '#3B82F6'),
    ('SUB-G2-' || NEW.id, NEW.id, 'คณิต (แบฟี)', 'วิชาสามัญ', '#2563EB'),
    ('SUB-G3-' || NEW.id, NEW.id, 'คณิตศาสตร์', 'วิชาสามัญ', '#3B82F6'),
    ('SUB-G4-' || NEW.id, NEW.id, 'สังคม', 'วิชาสามัญ', '#F59E0B'),
    ('SUB-G5-' || NEW.id, NEW.id, 'เคมี', 'วิชาสามัญ', '#EC4899'),
    ('SUB-G6-' || NEW.id, NEW.id, 'ฟิสิกส์ (แบฟิต)', 'วิชาสามัญ', '#8B5CF6'),
    ('SUB-G7-' || NEW.id, NEW.id, 'ชวีะ (แบวัน)', 'วิชาสามัญ', '#10B981'),
    ('SUB-G8-' || NEW.id, NEW.id, 'English 1 (บัง)', 'วิชาสามัญ', '#3B82F6'),
    ('SUB-G9-' || NEW.id, NEW.id, 'ศิลปะ (อาจารย์ก้อง)', 'วิชาสามัญ', '#F43F5E'),
    ('SUB-G10-' || NEW.id, NEW.id, 'ไทย (แบบัยด์)', 'วิชาสามัญ', '#EAB308'),
    ('SUB-G11-' || NEW.id, NEW.id, 'สุขศึกษา (แบฟี)', 'วิชาสามัญ', '#14B8A6')
    ON CONFLICT (id) DO NOTHING;

    -- 3. Seed Default Schedule for the new user
    INSERT INTO public.schedule (user_id, day, period_time, subject) VALUES
    (NEW.id, 'อาทิตย์', '07:50-08:30', 'อัลกุอาน'),
    (NEW.id, 'อาทิตย์', '08:50-09:40', 'MELAYU'),
    (NEW.id, 'อาทิตย์', '09:40-10:30', 'คณิตศาสตร์ (แบฟุรกอน)'),
    (NEW.id, 'อาทิตย์', '12:05-12:50', 'เคมี'),
    (NEW.id, 'อาทิตย์', '13:40-14:30', 'เคมี'),
    (NEW.id, 'จันทร์', '07:50-08:30', 'MELAYU'),
    (NEW.id, 'จันทร์', '08:50-09:40', 'อัลอากีดะฮ์ (แบวัน)'),
    (NEW.id, 'จันทร์', '10:30-11:20', 'สังคม'),
    (NEW.id, 'จันทร์', '11:20-12:05', 'ฟิสิกส์ (แบฟิต)'),
    (NEW.id, 'จันทร์', '13:40-14:30', 'ฟิสิกส์ (แบฟิต)'),
    (NEW.id, 'จันทร์', '14:30-15:20', 'ฟิสิกส์ (แบฟิต)'),
    (NEW.id, 'จันทร์', '15:20-16:10', 'อัลกุรอาน และตัฟซีร (แบบัยด์)'),
    (NEW.id, 'อังคาร', '07:50-08:30', 'อัลหะดีษ'),
    (NEW.id, 'อังคาร', '08:50-09:40', 'อัลอัคลาก'),
    (NEW.id, 'อังคาร', '09:40-10:30', 'ชวีะ (แบวัน)'),
    (NEW.id, 'อังคาร', '11:20-12:05', 'ฟิสิกส์ (แบฟิต)'),
    (NEW.id, 'อังคาร', '12:05-12:50', 'ฟิสิกส์ (แบฟิต)'),
    (NEW.id, 'อังคาร', '15:20-16:10', 'English 1 (บัง)'),
    (NEW.id, 'พุธ', '07:50-08:30', 'ฮาลากอฮ์'),
    (NEW.id, 'พุธ', '08:50-09:40', 'ฮาลากอฮ์'),
    (NEW.id, 'พุธ', '10:30-11:20', 'อัตตารีค'),
    (NEW.id, 'พุธ', '12:05-12:50', 'อัลฟิกฮ์'),
    (NEW.id, 'พุธ', '13:40-14:30', 'อัลหะดีษ'),
    (NEW.id, 'พุธ', '14:30-15:20', 'ตัฟซีร'),
    (NEW.id, 'พุธ', '15:20-16:10', 'ศิลปะ (อาจารย์ก้อง)'),
    (NEW.id, 'พฤหัสบดี', '07:50-08:30', 'คณิตศาสตร์ (แบฟุรกอน)'),
    (NEW.id, 'พฤหัสบดี', '08:50-09:40', 'ไทย (แบบัยด์)'),
    (NEW.id, 'พฤหัสบดี', '09:40-10:30', 'คณิตศาสตร์'),
    (NEW.id, 'พฤหัสบดี', '11:20-12:05', 'คณิต (แบฟุรกอน)'),
    (NEW.id, 'พฤหัสบดี', '12:05-12:50', 'คณิต (แบฟี)'),
    (NEW.id, 'พฤหัสบดี', '13:40-14:30', 'คณิต (แบฟี)'),
    (NEW.id, 'พฤหัสบดี', '14:30-15:20', 'อัลฟิกฮ์'),
    (NEW.id, 'พฤหัสบดี', '15:20-16:10', 'สุขศึกษา (แบฟี)')
    ON CONFLICT (user_id, day, period_time) DO UPDATE SET
        subject = EXCLUDED.subject;

    -- 4. Seed Default Settings for the new user
    INSERT INTO public.settings (id, user_id, data) VALUES
    (NEW.id::text, NEW.id, '{"urgentDays": 3, "defaultStatus": "ยังไม่ส่ง", "showCalDone": false, "autoDark": false}'::jsonb)
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger binding for new authenticated users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ==========================================================
-- Initial Seed Data (Original System Data)
-- ==========================================================

-- Subjects Seed
INSERT INTO subjects (id, name, category, color) VALUES
('SUB-R1', 'อัลกุอาน', 'วิชาศาสนา', '#10B981'),
('SUB-R2', 'อัลกุรอาน และตัฟซีร (แบบัยด์)', 'วิชาศาสนา', '#10B981'),
('SUB-R3', 'MELAYU', 'วิชาศาสนา', '#F59E0B'),
('SUB-R4', 'อัลอากีดะฮ์ (แบวัน)', 'วิชาศาสนา', '#8B5CF6'),
('SUB-R5', 'อัลหะดีษ', 'วิชาศาสนา', '#06B6D4'),
('SUB-R6', 'อัลอัคลาก', 'วิชาศาสนา', '#EC4899'),
('SUB-R7', 'ฮาลากอฮ์', 'วิชาศาสนา', '#14B8A6'),
('SUB-R8', 'อัตตารีค', 'วิชาศาสนา', '#F97316'),
('SUB-R9', 'ตัฟซีร', 'วิชาศาสนา', '#6366F1'),
('SUB-R10', 'อัลฟิกฮ์', 'วิชาศาสนา', '#84CC16'),
('SUB-G1', 'คณิตศาสตร์ (แบฟุรกอน)', 'วิชาสามัญ', '#3B82F6'),
('SUB-G2', 'คณิต (แบฟี)', 'วิชาสามัญ', '#2563EB'),
('SUB-G3', 'คณิตศาสตร์', 'วิชาสามัญ', '#3B82F6'),
('SUB-G4', 'สังคม', 'วิชาสามัญ', '#F59E0B'),
('SUB-G5', 'เคมี', 'วิชาสามัญ', '#EC4899'),
('SUB-G6', 'ฟิสิกส์ (แบฟิต)', 'วิชาสามัญ', '#8B5CF6'),
('SUB-G7', 'ชวีะ (แบวัน)', 'วิชาสามัญ', '#10B981'),
('SUB-G8', 'English 1 (บัง)', 'วิชาสามัญ', '#3B82F6'),
('SUB-G9', 'ศิลปะ (อาจารย์ก้อง)', 'วิชาสามัญ', '#F43F5E'),
('SUB-G10', 'ไทย (แบบัยด์)', 'วิชาสามัญ', '#EAB308'),
('SUB-G11', 'สุขศึกษา (แบฟี)', 'วิชาสามัญ', '#14B8A6')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    color = EXCLUDED.color;

-- Tasks Seed
INSERT INTO tasks (id, title, description, subject, category, order_date, due_date, status, priority, subject_color, image_base64, file_name, file_mime, is_deleted) VALUES
('T-1', 'แบบฝึกหัดคณิต หน้า 20', '', 'คณิตศาสตร์ (แบฟุรกอน)', 'วิชาสามัญ', NOW(), NOW() + INTERVAL '2 days', 'ยังไม่ส่ง', 'ด่วน', '#3B82F6', '', '', '', false),
('T-2', 'หาบุคคลที่เป็นนักวรรณกรรม หรือคนที่เกี่ยวข้องกับศาสนาอิสลาม', 'ส่งในรูปแบบการ์ด A4 แนะนำประวัติคร่าวๆ เพื่อใช้ประกอบแผนการสอนของคาบเรียนในอนาคต', 'MELAYU', 'วิชาศาสนา', NOW() - INTERVAL '5 days', NOW() + INTERVAL '4 days', 'ยังไม่ส่ง', 'ทั่วไป', '#F59E0B', '', '', '', false),
('T-3', 'แต่งงานแบบ อัลตะห์ลิล', 'เขียนสาระสำคัญ สรุปใจความเรื่องพิธีแต่งงานแบบอิสลามลงในสมุดประจำตัวของนักเรียน', 'อัลฟิกฮ์', 'วิชาศาสนา', NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', 'ส่งแล้ว', 'ทั่วไป', '#84CC16', '', '', '', false)
ON CONFLICT (id) DO NOTHING;

-- Schedule Seed
INSERT INTO schedule (day, period_time, subject) VALUES
('อาทิตย์', '07:50-08:30', 'อัลกุอาน'),
('อาทิตย์', '08:50-09:40', 'MELAYU'),
('อาทิตย์', '09:40-10:30', 'คณิตศาสตร์ (แบฟุรกอน)'),
('อาทิตย์', '12:05-12:50', 'เคมี'),
('อาทิตย์', '13:40-14:30', 'เคมี'),
('จันทร์', '07:50-08:30', 'MELAYU'),
('จันทร์', '08:50-09:40', 'อัลอากีดะฮ์ (แบวัน)'),
('จันทร์', '10:30-11:20', 'สังคม'),
('จันทร์', '11:20-12:05', 'ฟิสิกส์ (แบฟิต)'),
('จันทร์', '13:40-14:30', 'ฟิสิกส์ (แบฟิต)'),
('จันทร์', '14:30-15:20', 'ฟิสิกส์ (แบฟิต)'),
('จันทร์', '15:20-16:10', 'อัลกุรอาน และตัฟซีร (แบบัยด์)'),
('อังคาร', '07:50-08:30', 'อัลหะดีษ'),
('อังคาร', '08:50-09:40', 'อัลอัคลาก'),
('อังคาร', '09:40-10:30', 'ชวีะ (แบวัน)'),
('อังคาร', '11:20-12:05', 'ฟิสิกส์ (แบฟิต)'),
('อังคาร', '12:05-12:50', 'ฟิสิกส์ (แบฟิต)'),
('อังคาร', '15:20-16:10', 'English 1 (บัง)'),
('พุธ', '07:50-08:30', 'ฮาลากอฮ์'),
('พุธ', '08:50-09:40', 'ฮาลากอฮ์'),
('พุธ', '10:30-11:20', 'อัตตารีค'),
('พุธ', '12:05-12:50', 'อัลฟิกฮ์'),
('พุธ', '13:40-14:30', 'อัลหะดีษ'),
('พุธ', '14:30-15:20', 'ตัฟซีร'),
('พุธ', '15:20-16:10', 'ศิลปะ (อาจารย์ก้อง)'),
('พฤหัสบดี', '07:50-08:30', 'คณิตศาสตร์ (แบฟุรกอน)'),
('พฤหัสบดี', '08:50-09:40', 'ไทย (แบบัยด์)'),
('พฤหัสบดี', '09:40-10:30', 'คณิตศาสตร์'),
('พฤหัสบดี', '11:20-12:05', 'คณิต (แบฟุรกอน)'),
('พฤหัสบดี', '12:05-12:50', 'คณิต (แบฟี)'),
('พฤหัสบดี', '13:40-14:30', 'คณิต (แบฟี)'),
('พฤหัสบดี', '14:30-15:20', 'อัลฟิกฮ์'),
('พฤหัสบดี', '15:20-16:10', 'สุขศึกษา (แบฟี)')
ON CONFLICT (day, period_time) DO UPDATE SET
    subject = EXCLUDED.subject;

-- Settings Seed
INSERT INTO settings (id, data) VALUES
('default', '{"urgentDays": 3, "defaultStatus": "ยังไม่ส่ง", "showCalDone": false, "autoDark": false}'::jsonb)
ON CONFLICT (id) DO NOTHING;
