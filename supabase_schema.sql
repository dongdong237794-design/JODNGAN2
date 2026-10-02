-- ==========================================================
-- JodNGan (จดงาน) Database Schema for Supabase PostgreSQL
-- สร้างเฉพาะโครงสร้างตารางทั้งหมด (ตารางว่างเปล่า ให้ผู้ใช้กรอกเอง)
-- ==========================================================

-- 1. Create profiles table (User Identity)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    full_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 2. Create subjects table (ตารางวิชา - ว่างเปล่า ผู้ใช้เพิ่มเอง)
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL, -- เช่น 'วิชาสามัญ', 'วิชาศาสนา' หรือหมวดหมู่อื่นๆ
    color TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Create tasks table (ตารางรายการงาน - ว่างเปล่า ผู้ใช้เพิ่มเอง)
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

-- 4. Create schedule table (ตารางเรียน - ว่างเปล่า ผู้ใช้ใส่คาบและวิชาเอง)
CREATE TABLE IF NOT EXISTS schedule (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    day TEXT NOT NULL, -- เช่น 'อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี'
    period_time TEXT NOT NULL, -- เช่น '08:00-09:00'
    subject TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 5. Create settings table (ตารางการตั้งค่า)
CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 6. Create study_sessions table (ตารางบันทึกการจับเวลาอ่านหนังสือ Pomodoro)
CREATE TABLE IF NOT EXISTS study_sessions (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
    target_duration_minutes INTEGER NOT NULL DEFAULT 25,
    actual_duration_seconds INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- ==========================================================
-- Ensure columns exist (for existing tables)
-- ==========================================================
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time TEXT DEFAULT '23:59';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Unique constraint for schedule per user
DO $$
BEGIN
    ALTER TABLE schedule DROP CONSTRAINT IF EXISTS unique_day_period;
    ALTER TABLE schedule DROP CONSTRAINT IF EXISTS unique_user_day_period;
    BEGIN
        ALTER TABLE schedule ADD CONSTRAINT unique_user_day_period UNIQUE NULLS NOT DISTINCT (user_id, day, period_time);
    EXCEPTION WHEN OTHERS THEN
        ALTER TABLE schedule ADD CONSTRAINT unique_user_day_period UNIQUE (user_id, day, period_time);
    END;
END $$;

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
-- Row Level Security (RLS) Setup
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
    DROP POLICY IF EXISTS "Users can view subjects" ON subjects;
    DROP POLICY IF EXISTS "Users can manage own subjects" ON subjects;

    DROP POLICY IF EXISTS "Public access tasks" ON tasks;
    DROP POLICY IF EXISTS "Users can manage own tasks" ON tasks;

    DROP POLICY IF EXISTS "Public access schedule" ON schedule;
    DROP POLICY IF EXISTS "Users can view schedule" ON schedule;
    DROP POLICY IF EXISTS "Users can manage own schedule" ON schedule;

    DROP POLICY IF EXISTS "Public access settings" ON settings;
    DROP POLICY IF EXISTS "Users can view settings" ON settings;
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

-- 5. Settings Policies (User Ownership)
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

    -- 2. Seed Default Settings for the new user (No subjects or schedule seeded - user adds own)
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
-- Initial Config (No tasks, subjects, or schedule pre-inserted)
-- ==========================================================
INSERT INTO settings (id, data) VALUES
('default', '{"urgentDays": 3, "defaultStatus": "ยังไม่ส่ง", "showCalDone": false, "autoDark": false}'::jsonb)
ON CONFLICT (id) DO NOTHING;
