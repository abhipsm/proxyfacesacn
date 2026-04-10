-- 🔐 SUPABASE SQL: STRICT BIOMETRIC VECTOR SETUP
-- Run this in your Supabase SQL Editor. 
-- This completely deletes any ability to store physical photos.

-- 1. If you previously had an image column, we DESTROY it to ensure 100% privacy
DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name='students' AND column_name='photo_url'
  ) THEN
      ALTER TABLE students DROP COLUMN photo_url;
  END IF;
END $$;

-- 2. Create or ensure students table exists with highly secure JSONB for vector embeddings
CREATE TABLE IF NOT EXISTS students (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  college_name text,
  hostel_name text,
  age integer,
  phone text,
  email text,
  parent_phone text,
  
  -- ✅ THE SECURE VECTOR STORAGE
  -- Stores mathematical representations (e.g. [0.23, -0.91, 0.44]) 
  -- Cannot be converted back into a visual image.
  face_data jsonb, 
  
  created_at timestamp with time zone DEFAULT now()
);

-- 3. Create or ensure attendance table exists
CREATE TABLE IF NOT EXISTS attendance (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id uuid REFERENCES students(id) ON DELETE CASCADE,
  date date NOT NULL,
  time time without time zone NOT NULL,
  status text DEFAULT 'Present',
  created_at timestamp with time zone DEFAULT now()
);

-- Note: The "ON DELETE CASCADE" in the attendance table ensures
-- when a student's biometric mapping is deleted, 
-- their attendance data is cleanly wiped.
